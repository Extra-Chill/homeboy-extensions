<?php
declare(strict_types=1);

$runner = file_get_contents(__DIR__ . '/playground-runner.php');
if ($runner === false) {
    fwrite(STDERR, "Failed to read playground-runner.php\n");
    exit(1);
}

$start = strpos($runner, 'function pg_snapshot_hook_callback_ids');
$end = strpos($runner, '// Load the component during WordPress bootstrap');
if ($start === false || $end === false || $end <= $start) {
    fwrite(STDERR, "Failed to locate ability replay helpers in runner template\n");
    exit(1);
}

eval(substr($runner, $start, $end - $start));

$assertions = 0;

$assert_true = static function (bool $condition, string $message) use (&$assertions): void {
    ++$assertions;
    if (!$condition) {
        fwrite(STDERR, $message . "\n");
        exit(1);
    }
};

$calls = [];
$registry = (object) ['name' => 'registry'];

$old_callback = static function ($received_registry) use (&$calls): void {
    $calls[] = ['old', $received_registry];
};
$new_callback = static function ($received_registry) use (&$calls): void {
    $calls[] = ['new', $received_registry];
};
$zero_arg_callback = static function () use (&$calls): void {
    $calls[] = ['zero', null];
};

global $wp_filter;
$wp_filter = [
    'wp_abilities_api_init' => (object) [
        'callbacks' => [
            10 => [
                'old_callback' => [
                    'function' => $old_callback,
                    'accepted_args' => 1,
                ],
            ],
        ],
    ],
];

$snapshot = pg_snapshot_hook_callback_ids('wp_abilities_api_init');
$assert_true(isset($snapshot['10:old_callback']), 'snapshot should include existing callback');

$wp_filter['wp_abilities_api_init']->callbacks[10]['new_callback'] = [
    'function' => $new_callback,
    'accepted_args' => 1,
];
$wp_filter['wp_abilities_api_init']->callbacks[20]['zero_arg_callback'] = [
    'function' => $zero_arg_callback,
    'accepted_args' => 0,
];

pg_replay_new_hook_callbacks('wp_abilities_api_init', $snapshot, [$registry]);

$assert_true(count($calls) === 2, 'replay should invoke only newly-added callbacks');
$assert_true($calls[0][0] === 'new', 'new one-arg callback should run first');
$assert_true($calls[0][1] === $registry, 'new callback should receive registry argument');
$assert_true($calls[1][0] === 'zero', 'zero-arg callback should run second');
$assert_true($calls[1][1] === null, 'zero-arg callback should not receive registry argument');

$empty_snapshot = pg_snapshot_hook_callback_ids('missing_hook');
$assert_true($empty_snapshot === [], 'missing hook snapshot should be empty');
pg_replay_new_hook_callbacks('missing_hook', [], [$registry]);
$assert_true(count($calls) === 2, 'missing hook replay should be a no-op');

$assert_true(strpos($runner, "\$ability_callbacks = pg_snapshot_hook_callback_ids('wp_abilities_api_init');") !== false, 'runner should snapshot ability callbacks before activation');
$assert_true(strpos($runner, "pg_run_load_component_stage(['plugin_path' => \$plugin_path]);") !== false, 'runner should activate component after snapshot');
$assert_true(strpos($runner, "'wp_abilities_api_init',") !== false, 'runner should replay abilities init callbacks');

echo "Playground abilities replay smoke passed ({$assertions} assertions)\n";

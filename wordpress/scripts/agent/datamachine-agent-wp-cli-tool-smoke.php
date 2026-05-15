<?php
/**
 * Smoke test for the Data Machine agent WP-CLI tool surface.
 *
 * Run with: php wordpress/scripts/agent/datamachine-agent-wp-cli-tool-smoke.php
 */

namespace DataMachine\Core\Database\Agents {
    class Agents {}
}

namespace DataMachine\Core\Database\Chat {
    class ConversationStoreFactory {}
}

namespace DataMachine\Core\Database\Flows {
    class Flows {}
}

namespace DataMachine\Core\Database\Jobs {
    class Jobs {}
}

namespace DataMachine\Core\Database\Pipelines {
    class Pipelines {}
}

namespace DataMachine\Core {
    class PluginSettings {}
}

namespace {
    if ( ! defined( 'ABSPATH' ) ) {
        define( 'ABSPATH', __DIR__ . '/' );
    }

    class WP_CLI {
        public static string $last_command = '';

        public static function runcommand( string $command, array $options = array() ): object {
            self::$last_command = $command;

            return (object) array(
                'stdout'      => "Example Site\n",
                'stderr'      => '',
                'return_code' => 0,
                'options'     => $options,
            );
        }
    }

    $GLOBALS['homeboy_wp_cli_tool_actions']    = array();
    $GLOBALS['homeboy_wp_cli_tool_filters']    = array();
    $GLOBALS['homeboy_wp_cli_tool_abilities']  = array();
    $GLOBALS['homeboy_wp_cli_tool_categories'] = array();
    $GLOBALS['homeboy_wp_cli_tool_done']       = array();

    if ( ! function_exists( 'wp_set_current_user' ) ) {
        function wp_set_current_user( int $user_id ): void {}
    }

    if ( ! function_exists( 'add_action' ) ) {
        function add_action( string $tag, callable $callback, int $priority = 10, int $accepted_args = 1 ): void {
            $GLOBALS['homeboy_wp_cli_tool_actions'][ $tag ][ $priority ][] = $callback;
        }
    }

    if ( ! function_exists( 'do_action' ) ) {
        function do_action( string $tag ): void {
            $GLOBALS['homeboy_wp_cli_tool_done'][ $tag ] = true;
            if ( empty( $GLOBALS['homeboy_wp_cli_tool_actions'][ $tag ] ) ) {
                return;
            }
            ksort( $GLOBALS['homeboy_wp_cli_tool_actions'][ $tag ] );
            foreach ( $GLOBALS['homeboy_wp_cli_tool_actions'][ $tag ] as $callbacks ) {
                foreach ( $callbacks as $callback ) {
                    $callback();
                }
            }
        }
    }

    if ( ! function_exists( 'did_action' ) ) {
        function did_action( string $tag ): int {
            return empty( $GLOBALS['homeboy_wp_cli_tool_done'][ $tag ] ) ? 0 : 1;
        }
    }

    if ( ! function_exists( 'add_filter' ) ) {
        function add_filter( string $tag, callable $callback, int $priority = 10, int $accepted_args = 1 ): void {
            $GLOBALS['homeboy_wp_cli_tool_filters'][ $tag ][ $priority ][] = $callback;
        }
    }

    if ( ! function_exists( 'apply_filters' ) ) {
        function apply_filters( string $tag, $value ) {
            if ( empty( $GLOBALS['homeboy_wp_cli_tool_filters'][ $tag ] ) ) {
                return $value;
            }
            ksort( $GLOBALS['homeboy_wp_cli_tool_filters'][ $tag ] );
            foreach ( $GLOBALS['homeboy_wp_cli_tool_filters'][ $tag ] as $callbacks ) {
                foreach ( $callbacks as $callback ) {
                    $value = $callback( $value );
                }
            }
            return $value;
        }
    }

    if ( ! function_exists( 'wp_register_ability_category' ) ) {
        function wp_register_ability_category( string $slug, array $args ): void {
            $GLOBALS['homeboy_wp_cli_tool_categories'][ $slug ] = $args;
        }
    }

    if ( ! function_exists( 'wp_get_ability_category' ) ) {
        function wp_get_ability_category( string $slug ) {
            return $GLOBALS['homeboy_wp_cli_tool_categories'][ $slug ] ?? null;
        }
    }

    if ( ! function_exists( 'wp_register_ability' ) ) {
        function wp_register_ability( string $name, array $args ): void {
            $GLOBALS['homeboy_wp_cli_tool_abilities'][ $name ] = new class( $args ) {
                private array $args;

                public function __construct( array $args ) {
                    $this->args = $args;
                }

                public function get_input_schema(): array {
                    return $this->args['input_schema'] ?? array( 'type' => 'object', 'properties' => array() );
                }

                public function execute( array $input = array() ): array {
                    return ( $this->args['execute_callback'] )( $input );
                }
            };
        }
    }

    if ( ! function_exists( 'wp_get_ability' ) ) {
        function wp_get_ability( string $name ) {
            return $GLOBALS['homeboy_wp_cli_tool_abilities'][ $name ] ?? null;
        }
    }

    if ( ! function_exists( 'is_wp_error' ) ) {
        function is_wp_error( $value ): bool {
            return false;
        }
    }

    if ( ! function_exists( 'wp_json_encode' ) ) {
        function wp_json_encode( $value, int $flags = 0 ): string {
            return (string) json_encode( $value, $flags );
        }
    }

    putenv(
        'HOMEBOY_DATAMACHINE_AGENT_CONFIG=' . wp_json_encode(
            array(
                'dry_run'     => true,
                'bundle_path' => __DIR__,
                'agent_slug'  => 'wp-cli-tool-smoke-agent',
                'flow_slug'   => 'wp-cli-tool-smoke-flow',
                'prompt'      => 'Dry-run the WP-CLI tool smoke test.',
            )
        )
    );

    require __DIR__ . '/datamachine-agent-workload.php';

    $config = array(
        'enable_wp_cli_tool' => true,
        'engine_key'         => 'wp_gym',
    );
    homeboy_datamachine_agent_register_wp_cli_ability( $config );
    homeboy_datamachine_agent_bootstrap_abilities();
    homeboy_datamachine_agent_register_tool_recorders( $config );

    $tools = apply_filters( 'datamachine_resolved_tools', array() );
    if ( empty( $tools['run_wp_cli'] ) || ! is_array( $tools['run_wp_cli'] ) ) {
        fwrite( STDERR, "Expected run_wp_cli tool to be registered.\n" );
        exit( 1 );
    }

    $tool   = new Homeboy_Datamachine_Agent_Tool_Recorder();
    $result = $tool->handle_tool_call( array( 'command' => 'wp option get blogname' ), $tools['run_wp_cli'] );

    if ( empty( $result['success'] ) ) {
        fwrite( STDERR, "Expected run_wp_cli tool call to succeed.\n" );
        exit( 1 );
    }
    if ( 'option get blogname' !== WP_CLI::$last_command ) {
        fwrite( STDERR, "Expected WP_CLI::runcommand() to receive the normalized command.\n" );
        exit( 1 );
    }
    if ( "Example Site\n" !== ( $result['stdout'] ?? '' ) || 0 !== ( $result['exit_code'] ?? null ) ) {
        fwrite( STDERR, "Expected real WP-CLI stdout and exit status in tool response.\n" );
        exit( 1 );
    }

    echo "Data Machine agent WP-CLI tool smoke passed.\n";
}

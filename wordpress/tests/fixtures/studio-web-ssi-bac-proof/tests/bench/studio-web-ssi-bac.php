<?php
/**
 * Studio Web generated website artifact to SSI/BAC proof workload.
 *
 * The workload intentionally observes the current materialization path without
 * constraining generation. Studio Web can emit any website artifact bundle; this
 * proof verifies that a representative bundle can be compiled by BAC and
 * materialized by Static Site Importer inside the same WP Codebox runtime.
 */

return static function (): array {
	$started = microtime( true );
	$artifact = array(
		'schema'        => 'studio-web/static-site-artifact/v1',
		'artifact_type' => 'static-site',
		'version'       => 1,
		'entrypoint'    => 'website/index.html',
		'files'         => array(
			array(
				'path'      => 'website/index.html',
				'kind'      => 'html',
				'encoding'  => 'utf-8',
				'mime_type' => 'text/html',
				'content'   => '<!doctype html><html><head><meta charset="utf-8"><title>Studio Web Proof</title><link rel="stylesheet" href="style.css"></head><body><main class="proof"><section><h1>Studio Web Proof</h1><p>Generated website artifact content materializes through Static Site Importer and compiles through BAC.</p><a class="button" href="#menu">View menu</a></section></main></body></html>',
			),
			array(
				'path'      => 'website/style.css',
				'kind'      => 'css',
				'encoding'  => 'utf-8',
				'mime_type' => 'text/css',
				'content'   => 'body{margin:0;font-family:system-ui,sans-serif}.proof{min-height:100vh;display:grid;place-items:center;background:#111827;color:#f9fafb}.button{display:inline-block;margin-top:1rem;color:#111827;background:#fbbf24;padding:.75rem 1rem;border-radius:999px}',
			),
		),
	);

	if ( ! function_exists( 'bac_compile_website_artifact' ) ) {
		throw new RuntimeException( 'Block Artifact Compiler function bac_compile_website_artifact() is unavailable. Mount block-artifact-compiler as a validation dependency.' );
	}

	$compiler_result = bac_compile_website_artifact(
		$artifact,
		array(
			'include_bfb_report' => true,
		)
	);

	if ( 'failed' === ( $compiler_result['status'] ?? '' ) ) {
		throw new RuntimeException( 'BAC failed to compile the generated website artifact.' );
	}

	if ( ! function_exists( 'wp_get_ability' ) ) {
		throw new RuntimeException( 'WordPress Abilities API is unavailable in this runtime.' );
	}

	$import_mode = 'static-site-importer/import-theme';
	$ability     = wp_get_ability( $import_mode );
	if ( ! $ability || ! is_object( $ability ) || ! method_exists( $ability, 'execute' ) ) {
		throw new RuntimeException( 'Static Site Importer import ability is unavailable. Mount static-site-importer as a validation dependency.' );
	}
	wp_set_current_user( 1 );

	$upload_dir = wp_upload_dir();
	$site_root  = trailingslashit( $upload_dir['basedir'] ) . 'studio-web/website-proof';
	foreach ( $artifact['files'] as $file ) {
		$relative = preg_replace( '#^website/#', '', (string) ( $file['path'] ?? '' ) );
		if ( '' === $relative ) {
			continue;
		}

		$target = trailingslashit( $site_root ) . $relative;
		wp_mkdir_p( dirname( $target ) );
		$content = (string) ( $file['content'] ?? '' );
		if ( 'base64' === ( $file['encoding'] ?? '' ) ) {
			$decoded = base64_decode( $content, true );
			$content = false === $decoded ? '' : $decoded;
		}
		file_put_contents( $target, $content );
	}

	$report_path   = trailingslashit( $upload_dir['basedir'] ) . 'studio-web/ssi-bac-proof/import-report.json';
	$import_result = $ability->execute(
		array(
			'html_path'       => trailingslashit( $site_root ) . 'index.html',
			'name'            => 'Studio Web SSI BAC Proof',
			'slug'            => 'studio-web-ssi-bac-proof',
			'activate'        => false,
			'overwrite'       => true,
			'keep_source'     => true,
			'report'          => $report_path,
			'source_metadata' => array(
				'generator' => 'studio-web',
				'proof'     => 'homeboy-extension-wordpress/studio-web-ssi-bac',
			),
		)
	);

	if ( is_wp_error( $import_result ) ) {
		throw new RuntimeException( $import_result->get_error_message() );
	}

	if ( empty( $import_result['success'] ) ) {
		$error = is_array( $import_result['error'] ?? null ) ? $import_result['error'] : array();
		throw new RuntimeException( (string) ( $error['message'] ?? 'Static Site Importer did not report success.' ) );
	}

	$result        = is_array( $import_result['result'] ?? null ) ? $import_result['result'] : array();
	$summary       = is_array( $result['import_report_summary'] ?? null ) ? $result['import_report_summary'] : array();
	$quality       = is_array( $result['quality'] ?? null ) ? $result['quality'] : array();
	$compiler_diag = is_array( $compiler_result['diagnostics'] ?? null ) ? $compiler_result['diagnostics'] : array();

	return array(
		'metrics'   => array(
			'proof_success'          => 1,
			'artifact_file_count'    => count( $artifact['files'] ),
			'compiler_warning_count' => count( array_filter( $compiler_diag, static fn( $diagnostic ): bool => 'warning' === ( $diagnostic['severity'] ?? '' ) ) ),
			'import_fallback_count'  => (int) ( $summary['freeform_block_count'] ?? $quality['fallback_count'] ?? 0 ),
			'elapsed_ms'             => ( microtime( true ) - $started ) * 1000,
		),
		'metadata'  => array(
			'proof'            => 'studio-web-generated-website-artifact-to-ssi-to-bac',
			'artifact_schema'  => $artifact['schema'],
			'import_mode'      => $import_mode,
			'import_summary'   => $summary,
			'compiler_summary' => array(
				'schema'             => $compiler_result['schema'] ?? '',
				'status'             => $compiler_result['status'] ?? '',
				'input'              => $compiler_result['input'] ?? array(),
				'diagnostic_count'   => count( $compiler_diag ),
				'bfb_status'         => $compiler_result['bfb_report']['status'] ?? '',
				'block_markup_bytes' => strlen( (string) ( $compiler_result['wordpress_artifacts']['block_markup'] ?? '' ) ),
			),
		),
		'artifacts' => array(
			'import_report' => array(
				'path'  => str_replace( ABSPATH, '', $report_path ),
				'kind'  => 'json',
				'label' => 'Static Site Importer import report',
			),
		),
	);
};

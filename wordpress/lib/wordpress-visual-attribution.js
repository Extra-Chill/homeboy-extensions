'use strict';

const DEFAULT_LIMITS = Object.freeze({
	maxFindings: 10,
	maxRegions: 8,
	maxElementChanges: 25,
	maxStyleDeltas: 50,
});

const STYLE_CATEGORIES = new Set( [ 'layout', 'typography', 'paint', 'effect' ] );

/**
 * Reduce WP Codebox pixel, explanation, and DOM-snapshot evidence into a
 * bounded artifact that callers can use without understanding browser internals.
 * @param {Object} input WP Codebox visual evidence and optional provenance.
 */
function normalizeWordPressVisualAttribution( input = {} ) {
	const visualDiff = object( input.visualDiff );
	const explanation = validSchema( input.visualExplanation, 'wp-codebox/visual-explanation/v1' ) ? input.visualExplanation : null;
	const sourceSnapshot = snapshot( input.sourceDomSnapshot );
	const candidateSnapshot = snapshot( input.candidateDomSnapshot );
	const limits = normalizeLimits( input.limits );
	const comparison = object( visualDiff.comparison );
	const limitations = [ ...array( visualDiff.limitations ), ...array( explanation?.limitations ) ];

	if ( ! explanation ) {limitations.push( 'WP Codebox visual explanation evidence is unavailable; attribution is limited to pixel output.' );}
	if ( ! sourceSnapshot || ! candidateSnapshot ) {limitations.push( 'WP Codebox DOM snapshot evidence is unavailable; element-level attribution is limited.' );}

	const mismatchRegions = array( explanation?.mismatchRegions ).slice( 0, limits.maxRegions ).map( normalizeRegion );
	const selectorDeltas = array( explanation?.selectorDeltas ).slice( 0, limits.maxElementChanges ).map( normalizeSelectorDelta );
	const changes = array( explanation?.changes ).slice( 0, limits.maxElementChanges ).map( normalizeChange );
	const candidateProvenance = object( input.candidateProvenance );
	const elements = {
		changed: changes.map( ( change ) => enrichCandidatePath( change, candidateProvenance ) ),
		added: array( explanation?.added ).slice( 0, limits.maxElementChanges ).map( ( element ) => enrichCandidatePath( normalizeElement( element ), candidateProvenance ) ),
		removed: array( explanation?.removed ).slice( 0, limits.maxElementChanges ).map( normalizeElement ),
	};
	const styleDeltas = selectorDeltas.flatMap( ( delta ) => delta.styles.map( ( style ) => ( { selector: delta.selector, candidate_path: delta.candidate_path, ...style } ) ) ).slice( 0, limits.maxStyleDeltas );
	const stylesByCategory = Object.fromEntries( [ ...STYLE_CATEGORIES ].map( ( category ) => [ category, styleDeltas.filter( ( delta ) => delta.category === category ) ] ) );
	const topFindings = [
		...mismatchRegions.map( ( region ) => ( { kind: 'mismatch-region', summary: `${ region.pixels || 0 } mismatched pixels in ${ region.width }x${ region.height } region`, region } ) ),
		...selectorDeltas.filter( ( delta ) => hasGeometryDelta( delta.bounding_box.delta ) ).map( ( delta ) => ( { kind: 'geometry', summary: `${ delta.selector } has a bounding-box delta`, selector: delta.selector, bounding_box: delta.bounding_box } ) ),
		...styleDeltas.map( ( delta ) => ( { kind: 'style', summary: `${ delta.selector } ${ delta.property } differs`, selector: delta.selector, category: delta.category, property: delta.property } ) ),
	].slice( 0, limits.maxFindings );

	return {
		schema: 'homeboy/WordPressVisualAttribution/v1',
		pixel_summary: {
			mismatch_ratio: number( comparison.mismatchRatio ),
			mismatch_pixels: number( comparison.mismatchPixels ),
			total_pixels: number( comparison.totalPixels ),
			dimension_mismatch: Boolean( comparison.dimensionMismatch ),
		},
		evidence: {
			visual_explanation: ref( input.refs?.visualExplanation ),
			source_dom_snapshot: snapshotEvidence( input.refs?.sourceDomSnapshot, sourceSnapshot ),
			candidate_dom_snapshot: snapshotEvidence( input.refs?.candidateDomSnapshot, candidateSnapshot ),
		},
		top_findings: topFindings,
		mismatch_regions: mismatchRegions,
		selector_deltas: selectorDeltas,
		computed_style_deltas: stylesByCategory,
		elements,
		summary: {
			changed: explanation?.summary?.changedElements ?? elements.changed.length,
			added: explanation?.summary?.addedElements ?? elements.added.length,
			removed: explanation?.summary?.removedElements ?? elements.removed.length,
		},
		limits,
		limitations: unique( limitations ),
	};
}

function snapshot( value ) {
	return validSchema( value, 'wp-codebox/browser-dom-snapshot/v1' ) && object( value.snapshot ) ? value : null;
}

function validSchema( value, schema ) {
	return object( value ).schema === schema;
}

function normalizeRegion( region ) {
	const result = { x: number( region?.x ), y: number( region?.y ), width: number( region?.width ), height: number( region?.height ), pixels: number( region?.pixels ) };
	for ( const side of [ 'source', 'candidate' ] ) {
		const elements = array( region?.[ `${ side }Elements` ] ).slice( 0, 5 ).map( ( element ) => ( { path: string( element.path ), tag: string( element.tag ), bounding_box: element.boundingBox || null, overlap: element.overlap || null } ) );
		if ( elements.length ) {result[ `${ side }_elements` ] = elements;}
	}
	return result;
}

function normalizeSelectorDelta( delta ) {
	return {
		selector: string( delta?.selector ),
		source_path: string( delta?.sourcePath ),
		candidate_path: string( delta?.candidatePath ),
		bounding_box: {
			source: delta?.boundingBox?.source || null,
			candidate: delta?.boundingBox?.candidate || null,
			delta: delta?.boundingBox?.delta || {},
			severity: string( delta?.boundingBox?.severity ),
		},
		styles: array( delta?.styles ).map( normalizeStyle ),
	};
}

function normalizeChange( change ) {
	return { path: string( change?.path ), tag: string( change?.tag ), changes: object( change?.changes ) };
}

function normalizeElement( element ) {
	return { path: string( element?.path ), tag: string( element?.tag ), text: string( element?.text ), bounding_box: element?.boundingBox || null };
}

function normalizeStyle( style ) {
	return { property: string( style?.property ), source: string( style?.source ), candidate: string( style?.candidate ), category: STYLE_CATEGORIES.has( style?.category ) ? style.category : styleCategory( style?.property ), severity: string( style?.severity ), hint: string( style?.hint ) };
}

function styleCategory( property ) {
	if ( /font|line-height|letter-spacing|text-/.test( property || '' ) ) {return 'typography';}
	if ( /color|background|border|opacity/.test( property || '' ) ) {return 'paint';}
	if ( /transform|shadow|filter/.test( property || '' ) ) {return 'effect';}
	return 'layout';
}

function enrichCandidatePath( item, provenance ) {
	const path = item.candidate_path || item.path;
	return provenance[ path ] === undefined ? item : { ...item, provenance: provenance[ path ] };
}

function normalizeLimits( input ) {
	return Object.fromEntries( Object.entries( DEFAULT_LIMITS ).map( ( [ key, fallback ] ) => [ key, positiveInteger( input?.[ key ], fallback ) ] ) );
}

function hasGeometryDelta( delta ) {
	return Object.values( object( delta ) ).some( ( value ) => number( value ) !== 0 );
}

function object( value ) {
	return value && typeof value === 'object' && ! Array.isArray( value ) ? value : {};
}

function array( value ) {
	return Array.isArray( value ) ? value : [];
}

function string( value ) {
	return typeof value === 'string' ? value : '';
}

function number( value ) {
	return Number.isFinite( Number( value ) ) ? Number( value ) : 0;
}

function ref( value ) {
	return typeof value === 'string' && value ? value : null;
}

function snapshotEvidence( artifactRef, artifact ) {
	const path = ref( artifactRef );
	if ( ! path ) {
		return null;
	}
	return {
		path,
		element_count: number( artifact?.snapshot?.elementCount ),
		captured_elements: array( artifact?.snapshot?.capturedElements ).length,
		truncated: Boolean( artifact?.snapshot?.truncated ),
	};
}

function positiveInteger( value, fallback ) {
	return Number.isInteger( Number( value ) ) && Number( value ) > 0 ? Number( value ) : fallback;
}

function unique( values ) {
	return [ ...new Set( values.filter( ( value ) => typeof value === 'string' && value ) ) ];
}

module.exports = { normalizeWordPressVisualAttribution };

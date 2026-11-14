import {
	BufferAttribute,
	BufferGeometry,
	Plane,
	Vector3,
} from 'three';
import { MeshBVH, Section, sliceMesh, sectionToSVG } from 'three-mesh-bvh';
import { runTestMatrix } from './utils.js';

runTestMatrix( {
	indirect: [ false, true ],
}, ( desc, options ) => {

	describe( `SectionUtilities (${ desc })`, () => {

		function makeBox( sx = 1, sy = 1, sz = 1 ) {

			const geometry = new BoxGeometryMinusOne( sx, sy, sz );
			const bvh = new MeshBVH( geometry, options );
			return { geometry, bvh };

		}

		it( 'produces a single rectangular outer contour for a box slice', () => {

			const { bvh } = makeBox();
			const section = sliceMesh( bvh, new Plane( new Vector3( 0, 1, 0 ), 0 ) );

			expect( section.contours ).toHaveLength( 1 );
			expect( section.contours[ 0 ].hole ).toBe( false );
			expect( section.contours[ 0 ].points.length ).toBeGreaterThanOrEqual( 4 );
			expect( section.regions ).toHaveLength( 1 );
			expect( section.regions[ 0 ].holes ).toHaveLength( 0 );
			expect( section.openContours ).toHaveLength( 0 );

			// every point should lie on the plane
			for ( const point of section.points ) {

				expect( point.y ).toBeCloseTo( 0, 6 );

			}

		} );

		it( 'welds points so no duplicated slice vertices are generated', () => {

			const { bvh } = makeBox();
			const section = sliceMesh( bvh, new Plane( new Vector3( 0, 1, 0 ), 0 ) );

			// the non-indexed box slice is an 8-vertex ring (4 corners on source vertices plus
			// 4 edge midpoints). Every point must be unique despite the 12 triangles each
			// emitting a segment over shared edges.
			expect( section.points.length ).toBe( new Set( section.points.map( p => p.toArray().join( ',' ) ) ).size );

			const seen = new Set();
			for ( const point of section.points ) {

				const key = `${ point.x },${ point.y },${ point.z }`;
				expect( seen.has( key ) ).toBe( false );
				seen.add( key );

			}

			// every segment endpoint must resolve to an existing welded point - no dangling ids
			for ( const contour of section.contours ) {

				for ( const id of contour.points ) {

					expect( section.points[ id ] ).toBeDefined();

				}

			}

		} );

		it( 'welds shared vertices on an indexed geometry down to unique points', () => {

			// indexed box: the four plane-passing corner vertices are shared between triangles
			// so they must collapse to four welded points plus four edge intersections.
			const geometry = indexedBoxGeometry();
			const bvh = new MeshBVH( geometry, options );
			const section = sliceMesh( bvh, new Plane( new Vector3( 0, 1, 0 ), 0 ) );

			const unique = new Set( section.points.map( p => p.toArray().map( n => n.toFixed( 6 ) ).join( ',' ) ) );
			expect( unique.size ).toBe( section.points.length );
			expect( section.contours ).toHaveLength( 1 );
			expect( section.openContours ).toHaveLength( 0 );

		} );

		it( 'handles a plane passing exactly through source vertices without broken loops', () => {

			const { bvh } = makeBox();

			// plane at y = 0.5 passes exactly through the top four vertices of the box
			const section = sliceMesh( bvh, new Plane( new Vector3( 0, 1, 0 ), - 0.5 ) );

			expect( section.contours ).toHaveLength( 1 );
			expect( section.contours[ 0 ].points ).toHaveLength( 4 );
			expect( section.openContours ).toHaveLength( 0 );
			expect( section.points ).toHaveLength( 4 );
			expect( section.regions[ 0 ].outer ).toBe( 0 );

		} );

		it( 'handles coplanar triangles at the top of the mesh', () => {

			const { bvh } = makeBox();

			// the top face of the box (y = 0.5) is fully coplanar with the slice plane.
			// Plane: n.p + constant = 0, so y = 0.5 means normal (0,1,0) and constant -0.5.
			const section = sliceMesh( bvh, new Plane( new Vector3( 0, 1, 0 ), - 0.5 ) );

			// the side walls meet the plane along the four top edges, so the ring is still closed
			expect( section.contours ).toHaveLength( 1 );
			expect( section.contours[ 0 ].points ).toHaveLength( 4 );
			expect( section.openContours ).toHaveLength( 0 );
			expect( section.points.every( p => Math.abs( p.y - 0.5 ) < 1e-5 ) ).toBe( true );

		} );

		it( 'classifies holes and emits one fillable region with a hole for a torus', () => {

			const geometry = new TorusGeometryMinusOne( 0.5, 0.2, 16, 32 );
			const bvh = new MeshBVH( geometry, options );

			// slice through the equator of the torus - two nested loops
			const section = sliceMesh( bvh, new Plane( new Vector3( 0, 0, 1 ), 0 ) );

			expect( section.contours ).toHaveLength( 2 );
			const outer = section.contours.filter( c => ! c.hole );
			const holes = section.contours.filter( c => c.hole );
			expect( outer ).toHaveLength( 1 );
			expect( holes ).toHaveLength( 1 );
			expect( section.regions ).toHaveLength( 1 );
			expect( section.regions[ 0 ].holes ).toHaveLength( 1 );
			expect( section.openContours ).toHaveLength( 0 );

		} );

		it( 'builds capped triangle geometry with consistent winding and plane normals', () => {

			const { bvh } = makeBox();
			const section = sliceMesh( bvh, new Plane( new Vector3( 0, 1, 0 ), 0 ) );
			const cap = section.toGeometry();

			expect( cap ).not.toBeNull();
			expect( cap.index.count ).toBeGreaterThan( 0 );
			expect( cap.index.count % 3 ).toBe( 0 );

			const pos = cap.attributes.position;
			const normal = cap.attributes.normal;
			expect( normal ).toBeDefined();

			const a = new Vector3();
			const b = new Vector3();
			const c = new Vector3();
			const ab = new Vector3();
			const ac = new Vector3();
			const triNormal = new Vector3();
			const planeNormal = new Vector3( 0, 1, 0 );

			for ( let i = 0, l = cap.index.count; i < l; i += 3 ) {

				const ia = cap.index.getX( i );
				const ib = cap.index.getX( i + 1 );
				const ic = cap.index.getX( i + 2 );

				a.fromBufferAttribute( pos, ia );
				b.fromBufferAttribute( pos, ib );
				c.fromBufferAttribute( pos, ic );

				// all cap vertices lie on the slice plane
				expect( a.y ).toBeCloseTo( 0, 6 );
				expect( b.y ).toBeCloseTo( 0, 6 );
				expect( c.y ).toBeCloseTo( 0, 6 );

				triNormal.crossVectors( ab.copy( b ).sub( a ), ac.copy( c ).sub( a ) ).normalize();
				expect( triNormal.dot( planeNormal ) ).toBeGreaterThan( 0.999 );

				// the stored normal attribute matches the plane normal
				expect( normal.getY( ia ) ).toBeCloseTo( 1, 6 );

			}

		} );

		it( 'caps a torus region accounting for the hole', () => {

			const geometry = new TorusGeometryMinusOne( 0.5, 0.2, 16, 32 );
			const bvh = new MeshBVH( geometry, options );
			const section = sliceMesh( bvh, new Plane( new Vector3( 0, 0, 1 ), 0 ) );
			const cap = section.toGeometry();

			expect( cap ).not.toBeNull();
			expect( cap.index.count ).toBeGreaterThan( 0 );

			// the centroid of the torus must not be covered by any cap triangle
			const pos = cap.attributes.position;
			const rayOrigin = new Vector3( 0, 0, 0 );
			let insideCount = 0;
			for ( let i = 0, l = cap.index.count; i < l; i += 3 ) {

				const a = new Vector3().fromBufferAttribute( pos, cap.index.getX( i ) );
				const b = new Vector3().fromBufferAttribute( pos, cap.index.getX( i + 1 ) );
				const c = new Vector3().fromBufferAttribute( pos, cap.index.getX( i + 2 ) );
				if ( pointInTriangleXY( rayOrigin, a, b, c ) ) {

					insideCount ++;

				}

			}

			expect( insideCount ).toBe( 0 );

		} );

		it( 'supports arbitrary plane orientations', () => {

			const { bvh } = makeBox( 2, 2, 2 );
			const normal = new Vector3( 1, 1, 0 ).normalize();
			const section = sliceMesh( bvh, new Plane( normal, 0 ) );

			expect( section.contours.length ).toBeGreaterThan( 0 );
			for ( const point of section.points ) {

				expect( Math.abs( point.dot( normal ) ) ).toBeLessThan( 1e-5 );

			}

			const cap = section.toGeometry();
			expect( cap ).not.toBeNull();

		} );

		it( 'returns an empty section when the plane misses the geometry', () => {

			const { bvh } = makeBox();
			const section = sliceMesh( bvh, new Plane( new Vector3( 0, 1, 0 ), - 10 ) );

			expect( section.points ).toHaveLength( 0 );
			expect( section.contours ).toHaveLength( 0 );
			expect( section.regions ).toHaveLength( 0 );
			expect( section.toGeometry() ).toBeNull();

		} );

		it( 'stays deterministic across repeated slices', () => {

			const { bvh } = makeBox();
			const plane = new Plane( new Vector3( 0, 1, 0 ), 0 );

			const first = sliceMesh( bvh, plane );
			const second = sliceMesh( bvh, plane );

			expect( second.points.map( p => p.toArray() ) )
				.toEqual( first.points.map( p => p.toArray() ) );
			expect( second.contours.map( c => c.points ) )
				.toEqual( first.contours.map( c => c.points ) );

		} );

		it( 'serializes to an SVG document with even-odd fill and all contours', () => {

			const geometry = new TorusGeometryMinusOne( 0.5, 0.2, 12, 24 );
			const bvh = new MeshBVH( geometry, options );
			const section = sliceMesh( bvh, new Plane( new Vector3( 0, 0, 1 ), 0 ) );
			const svg = sectionToSVG( section );

			expect( svg.startsWith( '<svg' ) ).toBe( true );
			expect( svg.endsWith( '</svg>' ) ).toBe( true );
			expect( svg ).toContain( 'fill-rule="evenodd"' );
			expect( svg ).toContain( 'viewBox' );

			// one path sub-sequence per closed contour
			const moves = svg.match( /M/g ) || [];
			expect( moves.length ).toBe( section.contours.length );

		} );

		it( 'does not mutate the source geometry', () => {

			const { geometry, bvh } = makeBox();
			const before = geometry.attributes.position.array.slice();
			sliceMesh( bvh, new Plane( new Vector3( 0, 1, 0 ), 0.25 ) );
			expect( Array.from( geometry.attributes.position.array ) ).toEqual( Array.from( before ) );

		} );

		it( 'keeps non-manifold junctions connected into closed rings', () => {

			// two boxes sharing a single vertex at the origin - the slice through that vertex
			// hits a non-manifold junction where 8 triangles meet
			const geometry = new NonManifoldGeometry();
			const bvh = new MeshBVH( geometry, options );
			const section = sliceMesh( bvh, new Plane( new Vector3( 0, 1, 0 ), 0 ) );

			// both box cross sections must come out as closed loops, not fragments
			expect( section.openContours ).toHaveLength( 0 );
			expect( section.contours.length ).toBeGreaterThanOrEqual( 2 );
			for ( const contour of section.contours ) {

				expect( contour.points.length ).toBeGreaterThanOrEqual( 3 );

			}

			// the shared vertex is welded into a single point
			const originPoints = section.points.filter( p =>
				Math.abs( p.x ) < 1e-6 && Math.abs( p.y ) < 1e-6 && Math.abs( p.z ) < 1e-6
			);
			expect( originPoints.length ).toBeLessThanOrEqual( 1 );

		} );

		it( 'records the triangles visited', () => {

			const { bvh } = makeBox();
			const section = sliceMesh( bvh, new Plane( new Vector3( 0, 1, 0 ), 0 ) );
			expect( section.triangleCount ).toBeGreaterThan( 0 );
			expect( section.triangleCount ).toBeLessThanOrEqual( 12 );

		} );

		it( 'exposes the Section class and result shape', () => {

			const { bvh } = makeBox();
			const section = sliceMesh( bvh, new Plane( new Vector3( 0, 1, 0 ), 0 ) );
			expect( section ).toBeInstanceOf( Section );
			expect( section.plane ).toBeInstanceOf( Plane );

		} );

	} );

} );

describe( 'SectionUtilities coplanar option', () => {

	it( 'can include boundary edges of coplanar faces for open meshes', () => {

		const geometry = new OpenBoxGeometry();
		const bvh = new MeshBVH( geometry );

		const without = sliceMesh( bvh, new Plane( new Vector3( 0, 1, 0 ), - 1 ) );
		const withCoplanar = sliceMesh( bvh, new Plane( new Vector3( 0, 1, 0 ), - 1 ), {
			includeCoplanarFaces: true,
		} );

		expect( withCoplanar.contours.length ).toBeGreaterThanOrEqual( without.contours.length );
		expect( withCoplanar.points.length ).toBeGreaterThan( 0 );

	} );

} );

describe( 'SectionUtilities performance', () => {

	it( 'slices a 100k triangle mesh within 16ms', () => {

		const geometry = new SphereGeometryMinusOne( 2, 320, 160 );
		expect( geometry.index ? geometry.index.count / 3 : geometry.attributes.position.count / 3 )
			.toBeGreaterThan( 100000 );

		const bvh = new MeshBVH( geometry );
		const plane = new Plane( new Vector3( 0, 1, 0 ), 0.5 );

		// warm up to shake out lazy initialization and JIT compilation
		for ( let i = 0; i < 10; i ++ ) sliceMesh( bvh, plane );

		// measure several runs and take the median so a single GC or scheduler pause does not
		// flake the budget check.
		const runs = 25;
		const timings = [];
		let section = null;
		for ( let i = 0; i < runs; i ++ ) {

			const start = performance.now();
			section = sliceMesh( bvh, plane );
			timings.push( performance.now() - start );

		}

		timings.sort( ( a, b ) => a - b );
		const median = timings[ Math.floor( runs / 2 ) ];

		expect( section.contours.length ).toBeGreaterThan( 0 );
		expect( section.toGeometry() ).not.toBeNull();
		console.log(
			`SectionUtilities 100k triangle slice: median ${ median.toFixed( 2 ) }ms ` +
			`(min ${ timings[ 0 ].toFixed( 2 ) }ms, max ${ timings[ runs - 1 ].toFixed( 2 ) }ms)`
		);
		expect( median ).toBeLessThan( 16 );

	} );

} );

// minimal local geometry helpers so the tests do not depend on three example geometries

function indexedBoxGeometry( sx = 1, sy = 1, sz = 1 ) {

	const hx = sx / 2;
	const hy = sy / 2;
	const hz = sz / 2;
	const corners = [
		[ - hx, - hy, - hz ], [ hx, - hy, - hz ], [ hx, hy, - hz ], [ - hx, hy, - hz ],
		[ - hx, - hy, hz ], [ hx, - hy, hz ], [ hx, hy, hz ], [ - hx, hy, hz ],
	];
	const faces = [
		[ 0, 1, 2 ], [ 0, 2, 3 ],
		[ 4, 6, 5 ], [ 4, 7, 6 ],
		[ 0, 4, 5 ], [ 0, 5, 1 ],
		[ 3, 2, 6 ], [ 3, 6, 7 ],
		[ 0, 3, 7 ], [ 0, 7, 4 ],
		[ 1, 5, 6 ], [ 1, 6, 2 ],
	];
	const positions = [];
	for ( const corner of corners ) positions.push( ...corner );
	const indices = [];
	for ( const face of faces ) indices.push( ...face );

	const geometry = new BufferGeometry();
	geometry.setAttribute( 'position', new BufferAttribute( new Float32Array( positions ), 3 ) );
	geometry.setIndex( indices );
	return geometry;

}

function BoxGeometryMinusOne( sx, sy, sz ) {

	// unit box centered on the origin, non-indexed so vertex-on-plane behavior is exercised
	// through the position-based welding path as well.
	const hx = sx / 2;
	const hy = sy / 2;
	const hz = sz / 2;
	const corners = [
		[ - hx, - hy, - hz ], [ hx, - hy, - hz ], [ hx, hy, - hz ], [ - hx, hy, - hz ],
		[ - hx, - hy, hz ], [ hx, - hy, hz ], [ hx, hy, hz ], [ - hx, hy, hz ],
	];
	const faces = [
		[ 0, 1, 2 ], [ 0, 2, 3 ], // back
		[ 4, 6, 5 ], [ 4, 7, 6 ], // front
		[ 0, 4, 5 ], [ 0, 5, 1 ], // bottom
		[ 3, 2, 6 ], [ 3, 6, 7 ], // top
		[ 0, 3, 7 ], [ 0, 7, 4 ], // left
		[ 1, 5, 6 ], [ 1, 6, 2 ], // right
	];
	const positions = [];
	for ( const face of faces ) {

		for ( const idx of face ) {

			positions.push( ...corners[ idx ] );

		}

	}

	const geometry = new BufferGeometry();
	geometry.setAttribute( 'position', new BufferAttribute( new Float32Array( positions ), 3 ) );
	return geometry;

}

function TorusGeometryMinusOne( radius, tube, radialSegments, tubularSegments ) {

	// build a torus manually, indexed so shared ring vertices get welded
	const positions = [];
	const indices = [];
	for ( let j = 0; j <= radialSegments; j ++ ) {

		const v = j / radialSegments * Math.PI * 2;
		const cosV = Math.cos( v );
		const sinV = Math.sin( v );
		for ( let i = 0; i <= tubularSegments; i ++ ) {

			const u = i / tubularSegments * Math.PI * 2;
			const cosU = Math.cos( u );
			const sinU = Math.sin( u );
			positions.push(
				( radius + tube * cosV ) * cosU,
				( radius + tube * cosV ) * sinU,
				tube * sinV,
			);

		}

	}

	const stride = tubularSegments + 1;
	for ( let j = 1; j <= radialSegments; j ++ ) {

		for ( let i = 1; i <= tubularSegments; i ++ ) {

			const a = stride * ( j - 1 ) + ( i - 1 );
			const b = stride * j + ( i - 1 );
			const c = stride * j + i;
			const d = stride * ( j - 1 ) + i;
			indices.push( a, b, d, b, c, d );

		}

	}

	const geometry = new BufferGeometry();
	geometry.setAttribute( 'position', new BufferAttribute( new Float32Array( positions ), 3 ) );
	geometry.setIndex( indices );
	return geometry;

}

function SphereGeometryMinusOne( radius, widthSegments, heightSegments ) {

	const positions = [];
	const indices = [];
	const grid = [];

	for ( let iy = 0; iy <= heightSegments; iy ++ ) {

		const row = [];
		const v = iy / heightSegments;
		const phi = v * Math.PI;
		for ( let ix = 0; ix <= widthSegments; ix ++ ) {

			const u = ix / widthSegments;
			const theta = u * Math.PI * 2;
			const x = - radius * Math.cos( theta ) * Math.sin( phi );
			const y = radius * Math.cos( phi );
			const z = radius * Math.sin( theta ) * Math.sin( phi );
			row.push( positions.length / 3 );
			positions.push( x, y, z );

		}

		grid.push( row );

	}

	for ( let iy = 0; iy < heightSegments; iy ++ ) {

		for ( let ix = 0; ix < widthSegments; ix ++ ) {

			const a = grid[ iy ][ ix ];
			const b = grid[ iy + 1 ][ ix ];
			const c = grid[ iy + 1 ][ ix + 1 ];
			const d = grid[ iy ][ ix + 1 ];
			if ( iy !== 0 ) indices.push( a, b, d );
			if ( iy !== heightSegments - 1 ) indices.push( b, c, d );

		}

	}

	const geometry = new BufferGeometry();
	geometry.setAttribute( 'position', new BufferAttribute( new Float32Array( positions ), 3 ) );
	geometry.setIndex( indices );
	return geometry;

}

function NonManifoldGeometry() {

	// Two cubes that meet at exactly one vertex - the origin - which is referenced through the
	// same index. The origin is a corner of both cubes lying in the z = 0 slice plane, so at the
	// junction four slice edges meet (even degree) and the two cross-section rings must both
	// close through the shared point rather than fragment into open chains.
	const positions = [];
	const indices = [];

	const addVertex = ( x, y, z ) => {

		positions.push( x, y, z );
		return positions.length / 3 - 1;

	};

	// the single shared junction vertex at the origin
	const shared = addVertex( 0, 0, 0 );

	const addCube = corners => {

		// corner 0 is the one that coincides with the shared origin
		const ids = corners.map( ( corner, i ) => i === 0 ? shared : addVertex( ...corner ) );
		const faces = [
			[ 0, 1, 2 ], [ 0, 2, 3 ],
			[ 4, 6, 5 ], [ 4, 7, 6 ],
			[ 0, 4, 5 ], [ 0, 5, 1 ],
			[ 3, 2, 6 ], [ 3, 6, 7 ],
			[ 0, 3, 7 ], [ 0, 7, 4 ],
			[ 1, 5, 6 ], [ 1, 6, 2 ],
		];
		for ( const face of faces ) indices.push( ids[ face[ 0 ] ], ids[ face[ 1 ] ], ids[ face[ 2 ] ] );

	};

	// left cube extends into -x/-z and the right cube into +x/+z, touching only at corner 0.
	// Corner ordering matches the standard box layout with corner 0 at (min, min, min).
	const leftCube = [
		[ 0, 0, 0 ], [ - 1, 0, 0 ], [ - 1, 1, 0 ], [ 0, 1, 0 ],
		[ 0, 0, - 1 ], [ - 1, 0, - 1 ], [ - 1, 1, - 1 ], [ 0, 1, - 1 ],
	];
	const rightCube = [
		[ 0, 0, 0 ], [ 1, 0, 0 ], [ 1, 1, 0 ], [ 0, 1, 0 ],
		[ 0, 0, 1 ], [ 1, 0, 1 ], [ 1, 1, 1 ], [ 0, 1, 1 ],
	];

	addCube( leftCube );
	addCube( rightCube );

	const geometry = new BufferGeometry();
	geometry.setAttribute( 'position', new BufferAttribute( new Float32Array( positions ), 3 ) );
	geometry.setIndex( indices );
	return geometry;

}

function OpenBoxGeometry() {

	// four side walls and a bottom of a box, missing the top - top edge vertices sit on y = 1
	const positions = [];
	const quad = ( a, b, c, d ) => {

		positions.push( ...a, ...b, ...c, ...a, ...c, ...d );

	};

	// bottom at y = 0, open top at y = 1, unit footprint
	quad( [ 0, 0, 0 ], [ 1, 0, 0 ], [ 1, 0, 1 ], [ 0, 0, 1 ] );
	quad( [ 0, 0, 0 ], [ 0, 1, 0 ], [ 1, 1, 0 ], [ 1, 0, 0 ] );
	quad( [ 1, 0, 0 ], [ 1, 1, 0 ], [ 1, 1, 1 ], [ 1, 0, 1 ] );
	quad( [ 1, 0, 1 ], [ 1, 1, 1 ], [ 0, 1, 1 ], [ 0, 0, 1 ] );
	quad( [ 0, 0, 1 ], [ 0, 1, 1 ], [ 0, 1, 0 ], [ 0, 0, 0 ] );

	const geometry = new BufferGeometry();
	geometry.setAttribute( 'position', new BufferAttribute( new Float32Array( positions ), 3 ) );
	return geometry;

}

function pointInTriangleXY( p, a, b, c ) {

	const sign = ( p1, p2, p3 ) =>
		( p1.x - p3.x ) * ( p2.y - p3.y ) - ( p2.x - p3.x ) * ( p1.y - p3.y );

	const d1 = sign( p, a, b );
	const d2 = sign( p, b, c );
	const d3 = sign( p, c, a );
	const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
	const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
	return ! ( hasNeg && hasPos );

}

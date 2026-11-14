/** @import { Plane, BufferGeometry, Vector3 } from 'three' */
/** @import { BVH } from '../core/BVH.js' */
import { BufferAttribute, BufferGeometry, Plane, ShapeUtils, Vector2, Vector3 } from 'three';

const _v0 = /* @__PURE__ */ new Vector3();
const _v1 = /* @__PURE__ */ new Vector3();
const _v2 = /* @__PURE__ */ new Vector3();
const _v3 = /* @__PURE__ */ new Vector3();
const _normal = /* @__PURE__ */ new Vector3();
const _uAxis = /* @__PURE__ */ new Vector3();
const _vAxis = /* @__PURE__ */ new Vector3();

/**
 * A single closed contour of a planar slice. Each entry of `points` is an index into
 * {@link Section.points} and the loop is ordered such that consecutive entries are
 * connected with the final entry connecting back to the first.
 *
 * @typedef {Object} SectionContour
 * @property {Array<number>} points - Ordered, welded vertex indices forming a closed loop.
 * @property {boolean} hole - Whether the contour is a hole enclosed by an outer contour.
 * @property {number} area - The signed area of the contour in the slice plane coordinate frame.
 */

/**
 * The result of slicing a BVH with a plane.
 */
export class Section {

	constructor() {

		/**
		 * The plane the section was generated with in the local frame of the BVH.
		 * @type {Plane}
		 */
		this.plane = new Plane();

		/**
		 * Welded intersection points, in the local frame of the BVH. Every point lying exactly on
		 * the plane that is shared between triangles or edges appears exactly once.
		 * @type {Array<Vector3>}
		 */
		this.points = [];

		/**
		 * All closed contours extracted from the slice.
		 * @type {Array<SectionContour>}
		 */
		this.contours = [];

		/**
		 * Outer contours, each paired with the holes it encloses. Contours are referenced by
		 * index into `contours`.
		 * @type {Array<{ outer: number, holes: Array<number> }>}
		 */
		this.regions = [];

		/**
		 * Contours that could not be closed because the source mesh is open or non-manifold along
		 * the slice. Empty for closed, manifold meshes. The points are still welded.
		 * @type {Array<Array<number>>}
		 */
		this.openContours = [];

		/**
		 * Number of triangles visited during the slice.
		 * @type {number}
		 */
		this.triangleCount = 0;

	}

	/**
	 * Builds a triangulated, capped `BufferGeometry` lying in the slice plane. Outer contours are
	 * filled and holes are subtracted. The geometry includes a position and normal attribute as
	 * well as an index. Returns `null` if no fillable regions were found.
	 * @returns {BufferGeometry|null}
	 */
	toGeometry() {

		if ( this.regions.length === 0 ) {

			return null;

		}

		const positions = [];
		const normals = [];
		const indices = [];

		const normal = this.plane.normal;
		const uAxis = new Vector3();
		const vAxis = new Vector3();
		buildPlaneFrame( normal, uAxis, vAxis );
		const frameSign = Math.sign( uAxis.clone().cross( vAxis ).dot( normal ) ) || 1;
		const vertexMap = new Map();
		const getVertex = pointIndex => {

			let index = vertexMap.get( pointIndex );
			if ( index === undefined ) {

				index = positions.length / 3;
				const point = this.points[ pointIndex ];
				positions.push( point.x, point.y, point.z );
				normals.push( normal.x, normal.y, normal.z );
				vertexMap.set( pointIndex, index );

			}

			return index;

		};

		for ( let r = 0, rl = this.regions.length; r < rl; r ++ ) {

			const { outer, holes } = this.regions[ r ];
			const outerContour = this.contours[ outer ];

			// Earcut expects the outer ring counter-clockwise and holes clockwise in a 2d frame.
			const outer2d = contourTo2D( this, outerContour, uAxis, vAxis );
			if ( outer2d.length < 3 ) {

				continue;

			}

			const holes2d = [];
			for ( let h = 0, hl = holes.length; h < hl; h ++ ) {

				const hole2d = contourTo2D( this, this.contours[ holes[ h ] ], uAxis, vAxis );
				if ( hole2d.length >= 3 ) {

					holes2d.push( hole2d );

				}

			}

			let triangles;
			try {

				triangles = ShapeUtils.triangulateShape( outer2d, holes2d );

			} catch {

				// earcut can throw on degenerate, coincident contour input - skip the region
				// rather than failing the entire slice.
				continue;

			}

			// remap the local triangulation indices into global geometry indices. Earcut emits
			// outer ring vertices first followed by hole vertices, matching the flat vertex order.
			const flatContours = [ outerContour, ...holes.map( h => this.contours[ h ] ) ];
			const localIndex = i => {

				let offset = 0;
				for ( let c = 0; c < flatContours.length; c ++ ) {

					const contour = flatContours[ c ];
					if ( i < offset + contour.points.length ) {

						return getVertex( contour.points[ i - offset ] );

					}

					offset += contour.points.length;

				}

				// unreachable for valid earcut output
				return getVertex( outerContour.points[ 0 ] );

			};

			for ( let t = 0, tl = triangles.length; t < tl; t ++ ) {

				const tri = triangles[ t ];
				const a = localIndex( tri[ 0 ] );
				const b = localIndex( tri[ 1 ] );
				const c = localIndex( tri[ 2 ] );
				if ( frameSign > 0 ) {

					indices.push( a, b, c );

				} else {

					indices.push( a, c, b );

				}

			}

		}

		if ( indices.length === 0 ) {

			return null;

		}

		const geometry = new BufferGeometry();
		geometry.setAttribute( 'position', new BufferAttribute( new Float32Array( positions ), 3 ) );
		geometry.setAttribute( 'normal', new BufferAttribute( new Float32Array( normals ), 3 ) );
		geometry.setIndex( indices );
		geometry.boundingBox = null;
		geometry.boundingSphere = null;
		return geometry;

	}

}

/**
 * Options for {@link sliceMesh}.
 *
 * @typedef {Object} SliceOptions
 * @property {number} [epsilon=1e-10] - Signed distances with an absolute value below this are
 *   treated as zero, snapping the vertex onto the plane. Scaled by the magnitude of the plane
 *   normal so the value is in geometry units.
 * @property {number} [weldEpsilon=1e-7] - Positional tolerance used to weld intersection points
 *   that coincide in space, including points generated on non-indexed geometries. In geometry
 *   units.
 * @property {boolean} [includeCoplanarFaces=false] - Include the boundary edges of triangles
 *   lying fully in the plane as slice segments. Disabled by default because for closed meshes
 *   those edges are already emitted by the neighboring crossing triangles; enable it when
 *   slicing open meshes whose cap boundary is defined by coplanar faces.
 */

/**
 * Slices the geometry associated with `bvh` with the given plane and returns the welded
 * intersection contours along with a capped, triangulated representation.
 *
 * The plane is expected in the local frame of the BVH and all results are returned in that frame.
 * The function only relies on the BVH `shapecast` interface so it works with `MeshBVH` in
 * direct and indirect mode as well as `SkinnedMeshBVH`.
 *
 * @param {BVH} bvh
 * @param {Plane} plane
 * @param {SliceOptions} [options]
 * @returns {Section}
 */
export function sliceMesh( bvh, plane, options = {} ) {

	const {
		epsilon = 1e-10,
		weldEpsilon = 1e-7,
		includeCoplanarFaces = false,
	} = options;

	const section = new Section();
	section.plane.copy( plane ).normalize();

	const geometry = bvh.geometry;
	const indexAttribute = geometry.getIndex();
	const positionAttribute = geometry.attributes.position;
	const tolerance = epsilon * ( section.plane.normal.length() || 1 );

	// point table - points are registered by a position-quantized string key so vertices and
	// edge intersections that coincide in space resolve to a single welded point, even on
	// non-indexed geometry where interpolation introduces float rounding.
	const pointMap = new Map();
	const points = section.points;
	const invWeld = 1 / weldEpsilon;

	const positionKey = ( x, y, z ) =>
		`${ Math.round( x * invWeld ) },${ Math.round( y * invWeld ) },${ Math.round( z * invWeld ) }`;

	const registerPoint = ( key, x, y, z ) => {

		let id = pointMap.get( key );
		if ( id === undefined ) {

			id = points.length;
			points.push( new Vector3( x, y, z ) );
			pointMap.set( key, id );

		}

		return id;

	};

	// cache from source vertex index to welded point id for vertices lying on the plane
	const vertexPointCache = new Map();
	const registerVertex = vertexIndex => {

		let id = vertexPointCache.get( vertexIndex );
		if ( id === undefined ) {

			let x = positionAttribute.getX( vertexIndex );
			let y = positionAttribute.getY( vertexIndex );
			let z = positionAttribute.getZ( vertexIndex );

			// snap the vertex onto the plane when it is classified as on-plane so welded
			// anchors match the intersection points computed by neighboring triangles.
			const distance = section.plane.distanceToPoint( _v0.set( x, y, z ) );
			if ( Math.abs( distance ) <= tolerance ) {

				_v0.addScaledVector( section.plane.normal, - distance );
				x = _v0.x;
				y = _v0.y;
				z = _v0.z;

			}

			id = registerPoint( positionKey( x, y, z ), x, y, z );
			vertexPointCache.set( vertexIndex, id );

		}

		return id;

	};

	const edgePointCache = new Map();
	const getEdgePoint = ( ia, ib, va, vb, da, db ) => {

		// numeric undirected edge key - vertex ids are unique non-negative integers so this
		// encoding is collision-free without string allocation.
		const min = ia < ib ? ia : ib;
		const max = ia < ib ? ib : ia;
		const key = min * 0x100000000 + max;
		let id = edgePointCache.get( key );
		if ( id === undefined ) {

			const t = da / ( da - db );
			_v0.copy( va ).addScaledVector( _v1.copy( vb ).sub( va ), t );
			id = registerPoint( positionKey( _v0.x, _v0.y, _v0.z ), _v0.x, _v0.y, _v0.z );
			edgePointCache.set( key, id );

		}

		return id;

	};

	// undirected segment table used to build the half-edge graph
	const segmentKeys = new Set();
	const adjacency = new Map();
	const addSegment = ( a, b ) => {

		if ( a === b ) {

			return;

		}

		const min = a < b ? a : b;
		const max = a < b ? b : a;
		const key = min * 0x100000000 + max;
		if ( segmentKeys.has( key ) ) {

			return;

		}

		segmentKeys.add( key );
		addAdjacency( adjacency, a, b );
		addAdjacency( adjacency, b, a );

	};

	let triangleCount = 0;

	bvh.shapecast( {

		intersectsBounds: box => section.plane.intersectsBox( box ),

		intersectsTriangle: ( triangle, triangleIndex ) => {

			triangleCount ++;

			// The shapecast callback provides the geometry triangle index in both direct and
			// indirect mode (the indirect iterator resolves the primitive before invoking the
			// callback), so "triangle" and "triangleIndex" always describe the same triangle.
			const tri = triangleIndex;
			const tri3 = tri * 3;
			let i0 = tri3 + 0;
			let i1 = tri3 + 1;
			let i2 = tri3 + 2;
			if ( indexAttribute ) {

				i0 = indexAttribute.getX( i0 );
				i1 = indexAttribute.getX( i1 );
				i2 = indexAttribute.getX( i2 );

			}

			const vertexIndices = [ i0, i1, i2 ];
			const verts = [ triangle.a, triangle.b, triangle.c ];
			const distances = [
				section.plane.distanceToPoint( verts[ 0 ] ),
				section.plane.distanceToPoint( verts[ 1 ] ),
				section.plane.distanceToPoint( verts[ 2 ] ),
			];
			const sides = distances.map( d => d > tolerance ? 1 : d < - tolerance ? - 1 : 0 );

			if ( sides[ 0 ] === 0 && sides[ 1 ] === 0 && sides[ 2 ] === 0 ) {

				// fully coplanar triangle - its edges are only part of the cap boundary when the
				// mesh is open along the plane.
				if ( includeCoplanarFaces ) {

					const ids = vertexIndices.map( registerVertex );
					addSegment( ids[ 0 ], ids[ 1 ] );
					addSegment( ids[ 1 ], ids[ 2 ] );
					addSegment( ids[ 2 ], ids[ 0 ] );

				}

				return false;

			}

			// Clip the triangle against the plane. Vertices on the plane are kept as anchors so
			// neighboring triangles weld to the exact same points instead of producing a
			// numerically distinct intersection.
			const onPlane = [];
			const positive = [];
			const negative = [];
			for ( let i = 0; i < 3; i ++ ) {

				if ( sides[ i ] === 0 ) {

					onPlane.push( i );

				} else if ( sides[ i ] > 0 ) {

					positive.push( i );

				} else {

					negative.push( i );

				}

			}

			if ( onPlane.length === 2 ) {

				// the triangle touches the plane along a full edge - that edge is the segment
				const a = registerVertex( vertexIndices[ onPlane[ 0 ] ] );
				const b = registerVertex( vertexIndices[ onPlane[ 1 ] ] );
				addSegment( a, b );
				return false;

			}

			if ( onPlane.length === 1 ) {

				// one vertex on the plane, the other two on opposite sides produces one segment
				// from the anchored vertex to the crossing edge. Same-side vertices mean the
				// triangle only touches the plane at that single point.
				const anchor = registerVertex( vertexIndices[ onPlane[ 0 ] ] );
				if ( positive.length === 1 && negative.length === 1 ) {

					const pi = positive[ 0 ];
					const ni = negative[ 0 ];
					const cross = getEdgePoint(
						vertexIndices[ pi ], vertexIndices[ ni ],
						verts[ pi ], verts[ ni ], distances[ pi ], distances[ ni ],
					);
					addSegment( anchor, cross );

				}

				return false;

			}

			// generic straddle: one vertex on one side, two on the other - two crossing edges
			if ( positive.length === 1 || negative.length === 1 ) {

				const solo = positive.length === 1 ? positive[ 0 ] : negative[ 0 ];
				const otherA = ( solo + 1 ) % 3;
				const otherB = ( solo + 2 ) % 3;
				const pa = getEdgePoint(
					vertexIndices[ solo ], vertexIndices[ otherA ],
					verts[ solo ], verts[ otherA ], distances[ solo ], distances[ otherA ],
				);
				const pb = getEdgePoint(
					vertexIndices[ solo ], vertexIndices[ otherB ],
					verts[ solo ], verts[ otherB ], distances[ solo ], distances[ otherB ],
				);
				addSegment( pa, pb );

			}

			return false;

		},

	} );

	section.triangleCount = triangleCount;

	// build the 2d frame used both for junction angle sorting and contour classification
	buildPlaneFrame( section.plane.normal, _uAxis, _vAxis );

	// walk the segment graph into closed contours, pairing collinear and minimum-turn edges at
	// non-manifold junctions so rings stay connected instead of splitting into fragments.
	const { contours, openContours } = extractContours( section, adjacency );
	section.contours = contours;
	section.openContours = openContours;

	if ( contours.length > 0 ) {

		classifyContours( section, contours, _uAxis, _vAxis );

	}

	return section;

}

/**
 * Serializes a section to a standalone SVG document. Outer contours are drawn as filled paths
 * with holes cut out using the SVG even-odd fill rule. Coordinates are expressed in the local
 * frame of the BVH with the Y axis flipped to match screen space.
 *
 * @param {Section} section
 * @param {Object} [options]
 * @param {number} [options.precision=4] - Decimal digits used for path coordinates.
 * @param {string} [options.fill='rgba(128, 222, 234, 0.6)'] - Fill applied to the slice paths.
 * @param {string} [options.stroke='#00acc1'] - Stroke applied to the slice paths.
 * @param {number} [options.strokeWidth=0.5] - Stroke width in SVG units.
 * @returns {string}
 */
export function sectionToSVG( section, options = {} ) {

	const {
		precision = 4,
		fill = 'rgba(128, 222, 234, 0.6)',
		stroke = '#00acc1',
		strokeWidth = 0.5,
	} = options;

	if ( section.points.length === 0 ) {

		return '<svg xmlns="http://www.w3.org/2000/svg" version="1.1"></svg>';

	}

	const uAxis = new Vector3();
	const vAxis = new Vector3();
	buildPlaneFrame( section.plane.normal, uAxis, vAxis );
	const origin = section.plane.normal.clone().multiplyScalar( - section.plane.constant );

	const project2D = ( pointIndex, target ) => {

		const point = section.points[ pointIndex ];
		target.set(
			_v2.copy( point ).sub( origin ).dot( uAxis ),
			_v2.copy( point ).sub( origin ).dot( vAxis ),
		);
		return target;

	};

	let minX = Infinity;
	let minY = Infinity;
	let maxX = - Infinity;
	let maxY = - Infinity;
	const contourPaths = [];
	const project = ( pointIndex, target ) => {

		project2D( pointIndex, target );
		if ( target.x < minX ) minX = target.x;
		if ( target.y < minY ) minY = target.y;
		if ( target.x > maxX ) maxX = target.x;
		if ( target.y > maxY ) maxY = target.y;

	};

	for ( let c = 0, cl = section.contours.length; c < cl; c ++ ) {

		const contour = section.contours[ c ];
		let path = '';
		for ( let i = 0, l = contour.points.length; i < l; i ++ ) {

			project( contour.points[ i ], _v3 );
			const x = trim( _v3.x, precision );
			const y = trim( - _v3.y, precision );
			path += `${ i === 0 ? 'M' : 'L' }${ x } ${ y } `;

		}

		contourPaths.push( path + 'Z' );

	}

	for ( let c = 0, cl = section.openContours.length; c < cl; c ++ ) {

		const contour = section.openContours[ c ];
		let path = '';
		for ( let i = 0, l = contour.length; i < l; i ++ ) {

			project( contour[ i ], _v3 );
			const x = trim( _v3.x, precision );
			const y = trim( - _v3.y, precision );
			path += `${ i === 0 ? 'M' : 'L' }${ x } ${ y } `;

		}

		contourPaths.push( path );

	}

	const pad = strokeWidth;
	const width = Math.max( maxX - minX, 1e-6 );
	const height = Math.max( maxY - minY, 1e-6 );
	const viewBox = `${ trim( minX - pad, precision ) } ${ trim( - maxY - pad, precision ) } ` +
		`${ trim( width + pad * 2, precision ) } ${ trim( height + pad * 2, precision ) }`;

	return [
		'<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="' + viewBox + '">',
		`<path d="${ contourPaths.join( ' ' ) }" fill="${ fill }" fill-rule="evenodd" ` +
			`stroke="${ stroke }" stroke-width="${ strokeWidth }" stroke-linejoin="round"/>`,
		'</svg>',
	].join( '\n' );

}

function addAdjacency( adjacency, from, to ) {

	let list = adjacency.get( from );
	if ( ! list ) {

		list = [];
		adjacency.set( from, list );

	}

	list.push( to );

}

/**
 * Walks the undirected segment graph into closed loops.
 *
 * At a manifold vertex (degree 2) the single unused edge continues the loop. At a non-manifold
 * junction (degree 3+) the incident edges are sorted by angle in the slice plane and adjacent
 * edges are paired, which keeps each physical ring connected instead of stitching together
 * unrelated loops. Endpoints (degree 1) terminate an open chain.
 *
 * @param {Section} section
 * @param {Map<number, Array<number>>} adjacency
 * @returns {{ contours: Array<SectionContour>, openContours: Array<Array<number>> }}
 */
function extractContours( section, adjacency ) {

	// consumed undirected edges - each segment belongs to one loop (or to one open chain)
	const consumed = new Set();
	// numeric undirected edge key, collision-free for non-negative vertex ids
	const edgeKey = ( a, b ) => a < b ? a * 0x100000000 + b : b * 0x100000000 + a;
	const contours = [];
	const openContours = [];

	// Precompute a junction pairing once per junction. A ring that enters a junction along an
	// edge should leave along the edge most nearly opposite to it (the straightest continuation),
	// so incident edges are greedily paired by minimum turn angle. Collinear, exactly-opposite
	// edges therefore pair first which keeps straight rings intact through non-manifold vertices.
	// An odd edge count leaves one edge unpaired to terminate an open chain.
	const junctionPair = new Map();
	const buildJunctionPairing = vertex => {

		const neighbors = adjacency.get( vertex );
		const center = section.points[ vertex ];
		const dirs = [];
		for ( let i = 0, l = neighbors.length; i < l; i ++ ) {

			const neighbor = neighbors[ i ];
			const dir = _v0.copy( section.points[ neighbor ] ).sub( center );
			if ( dir.lengthSq() === 0 ) {

				continue;

			}

			dirs.push( { neighbor, dir: dir.clone().normalize() } );

		}

		const used = new Array( dirs.length ).fill( false );
		const pairing = new Map();

		// First lock in exactly collinear, opposite edge pairs (a ring passing straight through
		// the junction). These must always be joined regardless of how other edges are arranged.
		const COLLINEAR_DOT = - 1 + 1e-6;
		for ( let i = 0; i < dirs.length; i ++ ) {

			if ( used[ i ] ) {

				continue;

			}

			for ( let j = i + 1; j < dirs.length; j ++ ) {

				if ( used[ j ] ) {

					continue;

				}

				if ( dirs[ i ].dir.dot( dirs[ j ].dir ) <= COLLINEAR_DOT ) {

					used[ i ] = true;
					used[ j ] = true;
					pairing.set( dirs[ i ].neighbor, dirs[ j ].neighbor );
					pairing.set( dirs[ j ].neighbor, dirs[ i ].neighbor );
					break;

				}

			}

		}

		// score every remaining unordered pair by how close it is to a straight line (dot near -1)
		const scores = [];
		for ( let i = 0; i < dirs.length; i ++ ) {

			if ( used[ i ] ) {

				continue;

			}

			for ( let j = i + 1; j < dirs.length; j ++ ) {

				if ( used[ j ] ) {

					continue;

				}

				scores.push( {
					i,
					j,
					dot: dirs[ i ].dir.dot( dirs[ j ].dir ),
				} );

			}

		}

		scores.sort( ( a, b ) => a.dot - b.dot );
		for ( let s = 0; s < scores.length; s ++ ) {

			const { i, j } = scores[ s ];
			if ( used[ i ] || used[ j ] ) {

				continue;

			}

			used[ i ] = true;
			used[ j ] = true;
			pairing.set( dirs[ i ].neighbor, dirs[ j ].neighbor );
			pairing.set( dirs[ j ].neighbor, dirs[ i ].neighbor );

		}

		// any unpaired edge explicitly terminates here
		for ( let i = 0; i < dirs.length; i ++ ) {

			if ( ! used[ i ] ) {

				pairing.set( dirs[ i ].neighbor, null );

			}

		}

		junctionPair.set( vertex, pairing );

	};

	// precompute pairings for every junction up front so they always reflect the full incident
	// edge set, even after some edges have been consumed by an in-progress loop.
	const junctionVertices = [];
	for ( const [ vertex, neighbors ] of adjacency ) {

		if ( neighbors.length > 2 ) {

			buildJunctionPairing( vertex );
			junctionVertices.push( vertex );

		}

	}

	const pickNext = ( previous, current ) => {

		const candidates = adjacency.get( current );
		const available = [];
		for ( let i = 0, l = candidates.length; i < l; i ++ ) {

			const next = candidates[ i ];
			if ( next === current ) {

				continue;

			}

			if ( ! consumed.has( edgeKey( current, next ) ) ) {

				available.push( next );

			}

		}

		if ( available.length === 0 ) {

			return null;

		}

		// a junction always resolves through its precomputed angular pairing regardless of how
		// many incident edges happen to remain at this point in the traversal.
		const pairing = junctionPair.get( current );
		if ( pairing ) {

			const paired = pairing.get( previous );
			if ( paired !== null && paired !== undefined && ! consumed.has( edgeKey( current, paired ) ) ) {

				return paired;

			}

		}

		// manifold vertex (or fallback) - take the single remaining edge
		return available[ 0 ];

	};

	// seed loops from every unconsumed segment
	for ( const [ first, neighbors ] of adjacency ) {

		for ( let n = 0, nl = neighbors.length; n < nl; n ++ ) {

			const second = neighbors[ n ];
			if ( consumed.has( edgeKey( first, second ) ) ) {

				continue;

			}

			const loop = [ first, second ];
			let previous = first;
			let current = second;
			consumed.add( edgeKey( previous, current ) );
			let closed = false;

			while ( true ) {

				const next = pickNext( previous, current );
				if ( next === null ) {

					break;

				}

				consumed.add( edgeKey( current, next ) );
				previous = current;
				current = next;

				if ( current === first ) {

					closed = true;
					break;

				}

				loop.push( current );

			}

			if ( closed ) {

				if ( loop.length >= 3 ) {

					contours.push( {
						points: loop,
						hole: false,
						area: 0,
					} );

				}

			} else if ( loop.length >= 2 ) {

				openContours.push( loop );

			}

		}

	}

	return { contours, openContours };

}

/**
 * Computes signed 2d areas in the plane frame and assigns hole flags and outer/hole region
 * membership based on the contour containment tree.
 *
 * @param {Section} section
 * @param {Array<SectionContour>} contours
 * @param {Vector3} uAxis
 * @param {Vector3} vAxis
 */
function classifyContours( section, contours, uAxis, vAxis ) {

	const points2d = contours.map( contour => contourTo2D( section, contour, uAxis, vAxis ) );

	for ( let i = 0, l = contours.length; i < l; i ++ ) {

		contours[ i ].area = signedArea( points2d[ i ] );

	}

	// containment depth via point-in-polygon against every other contour. Coincident loops are
	// ignored so duplicate geometry does not flip the hole classification.
	const depth = new Array( contours.length ).fill( 0 );
	const parents = new Array( contours.length ).fill( - 1 );
	for ( let i = 0; i < contours.length; i ++ ) {

		const sample = points2d[ i ][ 0 ];
		let innermost = - 1;
		let innermostArea = Infinity;
		for ( let j = 0; j < contours.length; j ++ ) {

			if ( i === j ) {

				continue;

			}

			if ( pointInPolygon( sample, points2d[ j ] ) ) {

				const area = Math.abs( contours[ j ].area );
				if ( area < innermostArea ) {

					innermostArea = area;
					innermost = j;

				}

			}

		}

		parents[ i ] = innermost;
		depth[ i ] = innermost === - 1 ? 0 : depth[ innermost ] + 1;

	}

	for ( let i = 0, l = contours.length; i < l; i ++ ) {

		contours[ i ].hole = depth[ i ] % 2 === 1;

	}

	// group every hole under the nearest enclosing outer contour
	for ( let i = 0, l = contours.length; i < l; i ++ ) {

		if ( contours[ i ].hole ) {

			continue;

		}

		const holes = [];
		for ( let j = 0; j < l; j ++ ) {

			if ( ! contours[ j ].hole ) {

				continue;

			}

			let ancestor = parents[ j ];
			while ( ancestor !== - 1 && contours[ ancestor ].hole ) {

				ancestor = parents[ ancestor ];

			}

			if ( ancestor === i ) {

				holes.push( j );

			}

		}

		section.regions.push( { outer: i, holes } );

	}

}

/**
 * Builds an orthonormal 2d frame (u, v) for the plane where `u × v` points along `normal`.
 *
 * @param {Vector3} normal
 * @param {Vector3} uTarget
 * @param {Vector3} vTarget
 */
function buildPlaneFrame( normal, uTarget, vTarget ) {

	_normal.copy( normal );
	if ( _normal.lengthSq() === 0 ) {

		_normal.set( 0, 0, 1 );

	}

	_normal.normalize();
	const reference = Math.abs( _normal.z ) < 0.9 ? _v1.set( 0, 0, 1 ) : _v1.set( 1, 0, 0 );
	uTarget.crossVectors( reference, _normal ).normalize();
	vTarget.crossVectors( _normal, uTarget ).normalize();

}

/**
 * Projects a contour into the 2d plane frame.
 *
 * @param {Section} section
 * @param {SectionContour} contour
 * @param {Vector3} uAxis
 * @param {Vector3} vAxis
 * @returns {Array<Vector2>}
 */
function contourTo2D( section, contour, uAxis, vAxis ) {

	const origin = _v2.copy( section.plane.normal ).multiplyScalar( - section.plane.constant );
	const result = [];
	for ( let i = 0, l = contour.points.length; i < l; i ++ ) {

		_v3.copy( section.points[ contour.points[ i ] ] ).sub( origin );
		result.push( new Vector2(
			_v3.dot( uAxis ),
			_v3.dot( vAxis ),
		) );

	}

	return result;

}

/**
 * @param {Array<Vector2>} polygon
 * @returns {number}
 */
function signedArea( polygon ) {

	let sum = 0;
	for ( let i = 0, l = polygon.length; i < l; i ++ ) {

		const a = polygon[ i ];
		const b = polygon[ ( i + 1 ) % l ];
		sum += a.x * b.y - b.x * a.y;

	}

	return sum * 0.5;

}

/**
 * Ray-casting point-in-polygon test. Points on a polygon edge count as inside so loops that
 * touch at shared vertices still nest deterministically.
 *
 * @param {Vector2} point
 * @param {Array<Vector2>} polygon
 * @returns {boolean}
 */
function pointInPolygon( point, polygon ) {

	let inside = false;
	for ( let i = 0, j = polygon.length - 1, l = polygon.length; i < l; j = i ++ ) {

		const a = polygon[ i ];
		const b = polygon[ j ];

		// on-segment check
		const cross = ( point.x - a.x ) * ( b.y - a.y ) - ( point.y - a.y ) * ( b.x - a.x );
		if ( cross === 0 ) {

			const minX = Math.min( a.x, b.x );
			const maxX = Math.max( a.x, b.x );
			const minY = Math.min( a.y, b.y );
			const maxY = Math.max( a.y, b.y );
			if (
				point.x >= minX && point.x <= maxX &&
				point.y >= minY && point.y <= maxY
			) {

				return true;

			}

		}

		const intersects = ( a.y > point.y ) !== ( b.y > point.y ) &&
			point.x < ( ( b.x - a.x ) * ( point.y - a.y ) ) / ( b.y - a.y ) + a.x;
		if ( intersects ) {

			inside = ! inside;

		}

	}

	return inside;

}

/**
 * @param {number} value
 * @param {number} precision
 * @returns {number}
 */
function trim( value, precision ) {

	return Number( value.toFixed( precision ) );

}

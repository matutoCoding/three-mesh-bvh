import Stats from 'stats.js/src/Stats';
import * as dat from 'three/examples/jsm/libs/lil-gui.module.min.js';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import {
	acceleratedRaycast,
	computeBoundsTree,
	disposeBoundsTree,
	CONTAINED,
	INTERSECTED,
	NOT_INTERSECTED,
	BVHHelper,
} from 'three-mesh-bvh';

THREE.Mesh.prototype.raycast = acceleratedRaycast;
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;

const MAX_HISTORY_STEPS = 50;
const BRUSH_TYPES = [ 'normal', 'clay', 'flatten', 'smooth', 'mask' ];

let stats;
let scene, camera, renderer, controls, gui;
let targetMesh, brush, symmetryBrush, bvhHelper;
let brushActive = false;
let mouse = new THREE.Vector2(), lastMouse = new THREE.Vector2();
let mouseState = false, lastMouseState = false;
let lastCastPose = new THREE.Vector3();
let material, rightClick = false;

// mask and vertex -> triangle adjacency (CSR) for the current geometry
let maskAttr, colorAttr;
let vertTriOffsets = null;
let vertTriIndices = null;

// undo / redo history. Entries only store the vertices a stroke actually
// touched (index + previous values), never a full copy of the geometry.
let undoStack = [];
let redoStack = [];
let activeStroke = null;

// perf counters for the stats panel
let frameTimeMs = 16;
let strokeTimeMs = 0;
let refitTimeMs = 0;
let lastFrameTime = 0;
let statsPanel;
let lastStatsUpdate = 0;

// reusable temporaries - allocated once to avoid GC churn while stroking
const normalZ = new THREE.Vector3( 0, 0, 1 );
const _inverseMatrix = new THREE.Matrix4();
const _sphere = new THREE.Sphere();
const _tempVec = new THREE.Vector3();
const _tempVec2 = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _planePoint = new THREE.Vector3();
const _localPoint = new THREE.Vector3();
const _plane = new THREE.Plane();
const _triangle = new THREE.Triangle();
const _raycaster = new THREE.Raycaster();
const _rangeScratch = [];
const _smoothMap = new Map();
let _smoothPos = new Float32Array( 3 * 1024 );

const params = {
	matcap: 'Clay',

	size: 0.1,
	brush: 'clay',
	intensity: 50,
	maxSteps: 10,
	invert: false,
	symmetrical: true,
	flatShading: false,

	depth: 10,
	displayBVH: false,
};

const matcaps = {};

init();

// reset the sculpt mesh to the default icosahedron. A "?faces=" url parameter
// can be used to generate a higher resolution mesh for performance testing.
function reset() {

	const urlFaces = parseInt( new URLSearchParams( window.location.search ).get( 'faces' ), 10 );
	const detail = Number.isFinite( urlFaces ) && urlFaces > 0 ? Math.ceil( Math.sqrt( urlFaces / 20 ) ) : 100;

	// merge the vertices because they're not already merged
	let geometry = new THREE.IcosahedronGeometry( 1, detail );
	geometry.deleteAttribute( 'uv' );
	geometry = BufferGeometryUtils.mergeVertices( geometry );
	setupSculptGeometry( geometry );

}

// prepare a geometry for sculpting and swap it in as the target mesh
function setupSculptGeometry( geometry ) {

	if ( ! geometry.attributes.normal ) {

		geometry.computeVertexNormals();

	}

	// ensure there's an index for the adjacency list and bvh
	if ( ! geometry.index ) {

		const count = geometry.attributes.position.count;
		const indexArray = count > 65535 ? new Uint32Array( count ) : new Uint16Array( count );
		for ( let i = 0; i < count; i ++ ) {

			indexArray[ i ] = i;

		}

		geometry.setIndex( new THREE.BufferAttribute( indexArray, 1 ) );

	}

	geometry.attributes.position.setUsage( THREE.DynamicDrawUsage );
	geometry.attributes.normal.setUsage( THREE.DynamicDrawUsage );

	// mask attribute (0 = unmasked, 1 = fully masked) and a color attribute
	// used to visualize it
	const vertCount = geometry.attributes.position.count;
	maskAttr = new THREE.BufferAttribute( new Float32Array( vertCount ), 1 );
	maskAttr.setUsage( THREE.DynamicDrawUsage );
	geometry.setAttribute( 'mask', maskAttr );

	const colorArray = new Float32Array( vertCount * 3 );
	colorArray.fill( 1 );
	colorAttr = new THREE.BufferAttribute( colorArray, 3 );
	colorAttr.setUsage( THREE.DynamicDrawUsage );
	geometry.setAttribute( 'color', colorAttr );

	// don't create a bounding box because it's used in BVH construction but
	// will be out of date after moving vertices. See issue #222.
	geometry.computeBoundsTree( { setBoundingBox: false } );
	buildAdjacency( geometry );

	// dispose of the previous mesh if it exists
	if ( targetMesh ) {

		targetMesh.geometry.disposeBoundsTree();
		targetMesh.geometry.dispose();
		scene.remove( targetMesh );

	}

	// disable frustum culling because the verts will be updated
	targetMesh = new THREE.Mesh( geometry, material );
	targetMesh.frustumCulled = false;
	scene.add( targetMesh );

	// initialize bvh helper
	if ( ! bvhHelper ) {

		bvhHelper = new BVHHelper( targetMesh, params.depth );
		if ( params.displayBVH ) {

			scene.add( bvhHelper );

		}

	}

	bvhHelper.mesh = targetMesh;
	bvhHelper.update();

	// the history is only valid for the geometry it was recorded on
	undoStack = [];
	redoStack = [];
	activeStroke = null;

}

// build a vertex -> triangle adjacency list in CSR form. Used by the smooth
// brush and to recompute normals after undo / redo.
function buildAdjacency( geometry ) {

	const indexArray = geometry.index.array;
	const vertCount = geometry.attributes.position.count;
	const triCount = indexArray.length / 3;

	const offsets = new Uint32Array( vertCount + 1 );
	for ( let i = 0; i < indexArray.length; i ++ ) {

		offsets[ indexArray[ i ] + 1 ] ++;

	}

	for ( let i = 1; i <= vertCount; i ++ ) {

		offsets[ i ] += offsets[ i - 1 ];

	}

	vertTriOffsets = offsets;
	vertTriIndices = new Uint32Array( indexArray.length );

	const cursor = offsets.slice( 0, vertCount );
	for ( let t = 0; t < triCount; t ++ ) {

		for ( let c = 0; c < 3; c ++ ) {

			const v = indexArray[ 3 * t + c ];
			vertTriIndices[ cursor[ v ] ++ ] = t;

		}

	}

}

// add only the buffer ranges covering the given vertex indices to the
// attribute so the renderer uploads them instead of the whole buffer
function addAttributeRanges( attribute, indices ) {

	if ( indices.size === 0 ) {

		return;

	}

	_rangeScratch.length = 0;
	indices.forEach( i => _rangeScratch.push( i ) );
	_rangeScratch.sort( ( a, b ) => a - b );

	// merge indices into ranges, bridging small gaps to limit the number of
	// bufferSubData calls
	const GAP = 64;
	const itemSize = attribute.itemSize;
	let start = _rangeScratch[ 0 ];
	let prev = start;
	for ( let i = 1; i < _rangeScratch.length; i ++ ) {

		const v = _rangeScratch[ i ];
		if ( v - prev > GAP ) {

			attribute.addUpdateRange( start * itemSize, ( prev - start + 1 ) * itemSize );
			start = v;

		}

		prev = v;

	}

	attribute.addUpdateRange( start * itemSize, ( prev - start + 1 ) * itemSize );

}

// update the color used to visualize the mask at a vertex
function updateMaskColor( index ) {

	const m = maskAttr.getX( index );
	colorAttr.setXYZ( index, 1, 1 - 0.8 * m, 1 - 0.8 * m );

}

// history handling. A stroke records the original value of every vertex it
// touches, once, so a history entry is just a sparse delta.
function ensureStroke() {

	if ( ! activeStroke ) {

		activeStroke = {
			posSeen: new Set(),
			posIndices: [],
			posValues: [],
			maskSeen: new Set(),
			maskIndices: [],
			maskValues: [],
		};

	}

}

function recordPosition( index ) {

	ensureStroke();
	if ( activeStroke.posSeen.has( index ) ) {

		return;

	}

	const posAttr = targetMesh.geometry.attributes.position;
	activeStroke.posSeen.add( index );
	activeStroke.posIndices.push( index );
	activeStroke.posValues.push( posAttr.getX( index ), posAttr.getY( index ), posAttr.getZ( index ) );

}

function recordMaskValue( index ) {

	ensureStroke();
	if ( activeStroke.maskSeen.has( index ) ) {

		return;

	}

	activeStroke.maskSeen.add( index );
	activeStroke.maskIndices.push( index );
	activeStroke.maskValues.push( maskAttr.getX( index ) );

}

function finalizeStroke() {

	if ( ! activeStroke ) {

		return;

	}

	if ( activeStroke.posIndices.length || activeStroke.maskIndices.length ) {

		undoStack.push( {
			posIndices: Uint32Array.from( activeStroke.posIndices ),
			posValues: Float32Array.from( activeStroke.posValues ),
			maskIndices: Uint32Array.from( activeStroke.maskIndices ),
			maskValues: Float32Array.from( activeStroke.maskValues ),
		} );
		if ( undoStack.length > MAX_HISTORY_STEPS ) {

			undoStack.shift();

		}

		redoStack.length = 0;

	}

	activeStroke = null;

}

// write the stored values of an entry back into the geometry and return an
// entry holding the values that were overwritten (for the opposite stack)
function swapHistoryEntry( entry ) {

	const posAttr = targetMesh.geometry.attributes.position;

	const invPosValues = new Float32Array( entry.posIndices.length * 3 );
	for ( let i = 0; i < entry.posIndices.length; i ++ ) {

		const v = entry.posIndices[ i ];
		invPosValues[ i * 3 ] = posAttr.getX( v );
		invPosValues[ i * 3 + 1 ] = posAttr.getY( v );
		invPosValues[ i * 3 + 2 ] = posAttr.getZ( v );
		posAttr.setXYZ( v, entry.posValues[ i * 3 ], entry.posValues[ i * 3 + 1 ], entry.posValues[ i * 3 + 2 ] );

	}

	const invMaskValues = new Float32Array( entry.maskIndices.length );
	for ( let i = 0; i < entry.maskIndices.length; i ++ ) {

		const v = entry.maskIndices[ i ];
		invMaskValues[ i ] = maskAttr.getX( v );
		maskAttr.setX( v, entry.maskValues[ i ] );
		updateMaskColor( v );

	}

	return {
		posIndices: entry.posIndices,
		posValues: invPosValues,
		maskIndices: entry.maskIndices,
		maskValues: invMaskValues,
	};

}

// recompute normals, refit the bvh and flag buffer updates after an
// undo / redo
function refreshAfterHistory( entry ) {

	const geometry = targetMesh.geometry;
	const indexAttr = geometry.index;
	const posAttr = geometry.attributes.position;
	const normalAttr = geometry.attributes.normal;

	if ( entry.posIndices.length ) {

		const triangles = new Set();
		const normalIndices = new Set();
		const posIndices = new Set();
		for ( let i = 0; i < entry.posIndices.length; i ++ ) {

			const v = entry.posIndices[ i ];
			posIndices.add( v );
			const start = vertTriOffsets[ v ];
			const end = vertTriOffsets[ v + 1 ];
			for ( let j = start; j < end; j ++ ) {

				const t = vertTriIndices[ j ];
				triangles.add( t );
				const t3 = t * 3;
				normalIndices.add( indexAttr.getX( t3 ) );
				normalIndices.add( indexAttr.getX( t3 + 1 ) );
				normalIndices.add( indexAttr.getX( t3 + 2 ) );

			}

		}

		normalIndices.forEach( v => normalAttr.setXYZ( v, 0, 0, 0 ) );
		updateNormals( triangles, normalIndices );

		addAttributeRanges( posAttr, posIndices );
		addAttributeRanges( normalAttr, normalIndices );
		posAttr.needsUpdate = true;
		normalAttr.needsUpdate = true;

		const refitStart = performance.now();
		geometry.boundsTree.refit();
		refitTimeMs = performance.now() - refitStart;

		if ( bvhHelper.parent !== null ) {

			bvhHelper.update();

		}

	}

	if ( entry.maskIndices.length ) {

		const maskIndices = new Set();
		for ( let i = 0; i < entry.maskIndices.length; i ++ ) {

			const v = entry.maskIndices[ i ];
			updateMaskColor( v );
			maskIndices.add( v );

		}

		addAttributeRanges( maskAttr, maskIndices );
		addAttributeRanges( colorAttr, maskIndices );
		maskAttr.needsUpdate = true;
		colorAttr.needsUpdate = true;

	}

}

function undo() {

	finalizeStroke();
	if ( ! undoStack.length ) {

		return;

	}

	const entry = undoStack.pop();
	redoStack.push( swapHistoryEntry( entry ) );
	refreshAfterHistory( entry );

}

function redo() {

	finalizeStroke();
	if ( ! redoStack.length ) {

		return;

	}

	const entry = redoStack.pop();
	undoStack.push( swapHistoryEntry( entry ) );
	refreshAfterHistory( entry );

}

// model import / export
function loadModelFile( file ) {

	const ext = file.name.split( '.' ).pop().toLowerCase();
	if ( ext === 'obj' ) {

		file.text().then( text => {

			const group = new OBJLoader().parse( text );
			group.updateMatrixWorld( true );
			let mesh = null;
			group.traverse( c => {

				if ( ! mesh && c.isMesh ) {

					mesh = c;

				}

			} );
			if ( mesh ) {

				setTargetGeometry( mesh.geometry, mesh.matrixWorld );

			}

		} ).catch( err => console.error( err ) );

	} else if ( ext === 'glb' || ext === 'gltf' ) {

		file.arrayBuffer().then( buffer => {

			new GLTFLoader().parse( buffer, '', gltf => {

				gltf.scene.updateMatrixWorld( true );
				let mesh = null;
				gltf.scene.traverse( c => {

					if ( ! mesh && c.isMesh ) {

						mesh = c;

					}

				} );
				if ( mesh ) {

					setTargetGeometry( mesh.geometry, mesh.matrixWorld );

				}

			}, err => console.error( err ) );

		} ).catch( err => console.error( err ) );

	}

}

function setTargetGeometry( sourceGeometry, matrixWorld ) {

	let geometry = sourceGeometry.clone();
	geometry.applyMatrix4( matrixWorld );

	// remove attributes that would prevent vertices from being welded together
	for ( const name of Object.keys( geometry.attributes ) ) {

		if ( name !== 'position' && name !== 'normal' ) {

			geometry.deleteAttribute( name );

		}

	}

	geometry = BufferGeometryUtils.mergeVertices( geometry );
	if ( ! geometry.attributes.normal ) {

		geometry.computeVertexNormals();

	}

	// normalize the model to a unit sphere so the camera framing and default
	// brush sizes stay sensible
	geometry.computeBoundingSphere();
	const center = geometry.boundingSphere.center;
	const scale = 1 / ( geometry.boundingSphere.radius || 1 );
	geometry.translate( - center.x, - center.y, - center.z );
	geometry.scale( scale, scale, scale );

	setupSculptGeometry( geometry );

}

function saveBlob( blob, name ) {

	const a = document.createElement( 'a' );
	a.href = URL.createObjectURL( blob );
	a.download = name;
	a.click();
	setTimeout( () => URL.revokeObjectURL( a.href ), 1000 );

}

function exportOBJ() {

	const result = new OBJExporter().parse( targetMesh );
	saveBlob( new Blob( [ result ], { type: 'text/plain' } ), 'sculpt.obj' );

}

function exportGLB() {

	// export a cleaned copy without the sculpt-only attributes and with a
	// material the gltf exporter supports
	const geometry = targetMesh.geometry.clone();
	geometry.deleteAttribute( 'mask' );
	geometry.deleteAttribute( 'color' );
	const exportMesh = new THREE.Mesh( geometry, new THREE.MeshStandardMaterial() );
	new GLTFExporter().parse( exportMesh, result => {

		saveBlob( new Blob( [ result ], { type: 'model/gltf-binary' } ), 'sculpt.glb' );
		geometry.dispose();

	}, err => console.error( err ), { binary: true } );

}

function init() {

	const bgColor = 0x060609;

	// renderer setup
	renderer = new THREE.WebGLRenderer( { antialias: true } );
	renderer.setPixelRatio( window.devicePixelRatio );
	renderer.setSize( window.innerWidth, window.innerHeight );
	renderer.setClearColor( bgColor, 1 );
	renderer.setAnimationLoop( render );
	renderer.outputEncoding = THREE.sRGBEncoding;
	document.body.appendChild( renderer.domElement );
	renderer.domElement.style.touchAction = 'none';

	// scene setup
	scene = new THREE.Scene();
	scene.fog = new THREE.Fog( 0x263238 / 2, 20, 60 );

	const light = new THREE.DirectionalLight( 0xffffff, 0.5 );
	light.position.set( 1, 1, 1 );
	scene.add( light );
	scene.add( new THREE.AmbientLight( 0xffffff, 0.4 ) );

	// initialize brush cursor
	const brushSegments = [ new THREE.Vector3(), new THREE.Vector3( 0, 0, 1 ) ];
	for ( let i = 0; i < 50; i ++ ) {

		const nexti = i + 1;
		const x1 = Math.sin( 2 * Math.PI * i / 50 );
		const y1 = Math.cos( 2 * Math.PI * i / 50 );

		const x2 = Math.sin( 2 * Math.PI * nexti / 50 );
		const y2 = Math.cos( 2 * Math.PI * nexti / 50 );

		brushSegments.push(
			new THREE.Vector3( x1, y1, 0 ),
			new THREE.Vector3( x2, y2, 0 )
		);

	}

	brush = new THREE.LineSegments();
	brush.geometry.setFromPoints( brushSegments );
	brush.material.color.set( 0xfb8c00 );
	scene.add( brush );

	symmetryBrush = brush.clone();
	scene.add( symmetryBrush );

	// camera setup
	camera = new THREE.PerspectiveCamera( 75, window.innerWidth / window.innerHeight, 0.1, 50 );
	camera.position.set( 0, 0, 3 );
	camera.far = 100;
	camera.updateProjectionMatrix();

	// stats setup
	stats = new Stats();
	document.body.appendChild( stats.dom );

	// sculpt stats panel (face count, fps, stroke / refit timings)
	statsPanel = document.createElement( 'div' );
	statsPanel.id = 'sculpt-stats';
	document.body.appendChild( statsPanel );

	// init matcaps
	matcaps[ 'Clay' ] = new THREE.TextureLoader().load( '../textures/B67F6B_4B2E2A_6C3A34_F3DBC6-256px.png' );
	matcaps[ 'Red Wax' ] = new THREE.TextureLoader().load( '../textures/763C39_431510_210504_55241C-256px.png' );
	matcaps[ 'Shiny Green' ] = new THREE.TextureLoader().load( '../textures/3B6E10_E3F2C3_88AC2E_99CE51-256px.png' );
	matcaps[ 'Normal' ] = new THREE.TextureLoader().load( '../textures/7877EE_D87FC5_75D9C7_1C78C0-256px.png' );
	material = new THREE.MeshMatcapMaterial( {
		flatShading: params.flatShading,
		vertexColors: true,
	} );

	for ( const key in matcaps ) {

		matcaps[ key ].encoding = THREE.sRGBEncoding;

	}

	// geometry setup
	reset();

	// hidden file input used by the import button
	const fileInput = document.createElement( 'input' );
	fileInput.type = 'file';
	fileInput.accept = '.obj,.glb,.gltf';
	fileInput.style.display = 'none';
	fileInput.addEventListener( 'change', () => {

		if ( fileInput.files.length ) {

			loadModelFile( fileInput.files[ 0 ] );

		}

		fileInput.value = '';

	} );
	document.body.appendChild( fileInput );

	gui = new dat.GUI();
	gui.add( params, 'matcap', Object.keys( matcaps ) );

	const sculptFolder = gui.addFolder( 'Sculpting' );
	sculptFolder.add( params, 'brush', BRUSH_TYPES );
	sculptFolder.add( params, 'size' ).min( 0.025 ).max( 0.25 ).step( 0.005 );
	sculptFolder.add( params, 'intensity' ).min( 1 ).max( 100 ).step( 1 );
	sculptFolder.add( params, 'maxSteps' ).min( 1 ).max( 25 ).step( 1 );
	sculptFolder.add( params, 'symmetrical' );
	sculptFolder.add( params, 'invert' );
	sculptFolder.add( params, 'flatShading' ).onChange( value => {

		targetMesh.material.flatShading = value;
		targetMesh.material.needsUpdate = true;

	} );
	sculptFolder.open();

	const historyFolder = gui.addFolder( 'History' );
	historyFolder.add( { undo }, 'undo' );
	historyFolder.add( { redo }, 'redo' );
	historyFolder.open();

	const ioFolder = gui.addFolder( 'Import / Export' );
	ioFolder.add( { importModel: () => fileInput.click() }, 'importModel' ).name( 'Import OBJ / GLB' );
	ioFolder.add( { exportOBJ }, 'exportOBJ' ).name( 'Export OBJ' );
	ioFolder.add( { exportGLB }, 'exportGLB' ).name( 'Export GLB' );
	ioFolder.open();

	const helperFolder = gui.addFolder( 'BVH Helper' );
	helperFolder.add( params, 'depth' ).min( 1 ).max( 20 ).step( 1 ).onChange( d => {

		bvhHelper.depth = parseFloat( d );
		bvhHelper.update();

	} );
	helperFolder.add( params, 'displayBVH' ).onChange( display => {

		if ( display ) {

			scene.add( bvhHelper );
			bvhHelper.update();

		} else {

			scene.remove( bvhHelper );

		}

	} );
	helperFolder.open();

	gui.add( { reset }, 'reset' );
	gui.add( { rebuildBVH: () => {

		// don't create a bounding box because it's used in BVH construction but
		// will be out of date after moving vertices. See issue #222.
		targetMesh.geometry.computeBoundsTree( { setBoundingBox: false } );
		bvhHelper.update();

	} }, 'rebuildBVH' );
	gui.open();

	window.addEventListener( 'resize', function () {

		camera.aspect = window.innerWidth / window.innerHeight;
		camera.updateProjectionMatrix();

		renderer.setSize( window.innerWidth, window.innerHeight );

	}, false );

	window.addEventListener( 'pointermove', function ( e ) {

		mouse.x = ( e.clientX / window.innerWidth ) * 2 - 1;
		mouse.y = - ( e.clientY / window.innerHeight ) * 2 + 1;
		brushActive = true;

	} );

	window.addEventListener( 'pointerdown', e => {

		mouse.x = ( e.clientX / window.innerWidth ) * 2 - 1;
		mouse.y = - ( e.clientY / window.innerHeight ) * 2 + 1;
		mouseState = Boolean( e.buttons & 3 );
		rightClick = Boolean( e.buttons & 2 );
		brushActive = true;

		const raycaster = new THREE.Raycaster();
		raycaster.setFromCamera( mouse, camera );
		raycaster.firstHitOnly = true;

		const res = raycaster.intersectObject( targetMesh );
		controls.enabled = res.length === 0;

	}, true );

	window.addEventListener( 'pointerup', e => {

		mouseState = Boolean( e.buttons & 3 );
		finalizeStroke();
		if ( e.pointerType === 'touch' ) {

			brushActive = false;

		}

	} );

	window.addEventListener( 'pointercancel', () => {

		finalizeStroke();

	} );

	window.addEventListener( 'blur', () => {

		finalizeStroke();

	} );

	window.addEventListener( 'contextmenu', function ( e ) {

		e.preventDefault();

	} );

	window.addEventListener( 'wheel', function ( e ) {

		let delta = e.deltaY;

		if ( e.deltaMode === 1 ) {

			delta *= 40;

		}

		if ( e.deltaMode === 2 ) {

			delta *= 40;

		}

		params.size += delta * 0.0001;
		params.size = Math.max( Math.min( params.size, 0.25 ), 0.025 );
		gui.controllersRecursive().forEach( c => c.updateDisplay() );

	} );

	// keyboard shortcuts:
	// [ / ] brush size, - / = brush intensity, 1-5 select brush,
	// x toggle symmetry, ctrl/cmd+z undo, ctrl/cmd+shift+z or ctrl/cmd+y redo
	window.addEventListener( 'keydown', e => {

		const tag = e.target && e.target.tagName;
		if ( tag === 'INPUT' || tag === 'TEXTAREA' ) {

			return;

		}

		const key = e.key.toLowerCase();
		if ( ( e.ctrlKey || e.metaKey ) && key === 'z' ) {

			e.preventDefault();
			if ( e.shiftKey ) {

				redo();

			} else {

				undo();

			}

		} else if ( ( e.ctrlKey || e.metaKey ) && key === 'y' ) {

			e.preventDefault();
			redo();

		} else if ( key === '[' ) {

			params.size = Math.max( params.size - 0.005, 0.025 );

		} else if ( key === ']' ) {

			params.size = Math.min( params.size + 0.005, 0.25 );

		} else if ( key === '-' ) {

			params.intensity = Math.max( params.intensity - 2, 1 );

		} else if ( key === '=' ) {

			params.intensity = Math.min( params.intensity + 2, 100 );

		} else if ( key >= '1' && key <= String( BRUSH_TYPES.length ) ) {

			params.brush = BRUSH_TYPES[ parseInt( key, 10 ) - 1 ];

		} else if ( key === 'x' ) {

			params.symmetrical = ! params.symmetrical;

		} else {

			return;

		}

		gui.controllersRecursive().forEach( c => c.updateDisplay() );

	} );

	// drag and drop model import
	window.addEventListener( 'dragover', e => e.preventDefault() );
	window.addEventListener( 'drop', e => {

		e.preventDefault();
		if ( e.dataTransfer.files.length ) {

			loadModelFile( e.dataTransfer.files[ 0 ] );

		}

	} );

	controls = new OrbitControls( camera, renderer.domElement );
	controls.minDistance = 1.5;

	controls.addEventListener( 'start', function () {

		this.active = true;

	} );

	controls.addEventListener( 'end', function () {

		this.active = false;

	} );

}

// laplacian smooth over the given vertex indices. Neighbor positions are
// snapshotted first so the result doesn't depend on iteration order, which
// also keeps the symmetric pass consistent.
function applySmoothBrush( indices ) {

	const geometry = targetMesh.geometry;
	const indexArray = geometry.index.array;
	const posAttr = geometry.attributes.position;
	const normalAttr = geometry.attributes.normal;

	// snapshot the positions of all affected vertices and their neighbors
	_smoothMap.clear();
	indices.forEach( v => {

		snapshotSmoothVertex( v );
		const start = vertTriOffsets[ v ];
		const end = vertTriOffsets[ v + 1 ];
		for ( let i = start; i < end; i ++ ) {

			const t3 = vertTriIndices[ i ] * 3;
			snapshotSmoothVertex( indexArray[ t3 ] );
			snapshotSmoothVertex( indexArray[ t3 + 1 ] );
			snapshotSmoothVertex( indexArray[ t3 + 2 ] );

		}

	} );

	// record undo state before moving anything
	indices.forEach( v => recordPosition( v ) );

	indices.forEach( v => {

		const maskFactor = 1.0 - maskAttr.getX( v );
		if ( maskFactor <= 0.0 ) {

			return;

		}

		// average the positions of the neighboring vertices
		let ax = 0, ay = 0, az = 0, count = 0;
		const start = vertTriOffsets[ v ];
		const end = vertTriOffsets[ v + 1 ];
		for ( let i = start; i < end; i ++ ) {

			const t3 = vertTriIndices[ i ] * 3;
			for ( let c = 0; c < 3; c ++ ) {

				const u = indexArray[ t3 + c ];
				if ( u !== v ) {

					const o = _smoothMap.get( u );
					ax += _smoothPos[ o ];
					ay += _smoothPos[ o + 1 ];
					az += _smoothPos[ o + 2 ];
					count ++;

				}

			}

		}

		if ( count === 0 ) {

			return;

		}

		ax /= count;
		ay /= count;
		az /= count;

		const o = _smoothMap.get( v );
		const ox = _smoothPos[ o ];
		const oy = _smoothPos[ o + 1 ];
		const oz = _smoothPos[ o + 2 ];

		const dx = ox - _localPoint.x;
		const dy = oy - _localPoint.y;
		const dz = oz - _localPoint.z;
		const dist = Math.sqrt( dx * dx + dy * dy + dz * dz );
		const falloff = Math.max( 1.0 - dist / params.size, 0.0 );
		let weight = params.intensity * 0.01 * falloff * maskFactor;
		weight = Math.min( Math.max( weight, 0 ), 1 );

		posAttr.setXYZ(
			v,
			ox + ( ax - ox ) * weight,
			oy + ( ay - oy ) * weight,
			oz + ( az - oz ) * weight,
		);
		normalAttr.setXYZ( v, 0, 0, 0 );

	} );

}

function snapshotSmoothVertex( v ) {

	if ( _smoothMap.has( v ) ) {

		return;

	}

	const posAttr = targetMesh.geometry.attributes.position;
	const offset = _smoothMap.size * 3;
	if ( offset + 3 > _smoothPos.length ) {

		const next = new Float32Array( _smoothPos.length * 2 );
		next.set( _smoothPos );
		_smoothPos = next;

	}

	_smoothPos[ offset ] = posAttr.getX( v );
	_smoothPos[ offset + 1 ] = posAttr.getY( v );
	_smoothPos[ offset + 2 ] = posAttr.getZ( v );
	_smoothMap.set( v, offset );

}

// Run the perform the brush movement. Returns true if vertex positions were
// modified.
function performStroke( point, brushObject, brushOnly = false, accumulatedFields = {} ) {

	const {
		accumulatedTriangles = new Set(),
		accumulatedIndices = new Set(),
		accumulatedTraversedNodeIndices = new Set(),
		accumulatedMaskIndices = new Set(),
	} = accumulatedFields;

	const geometry = targetMesh.geometry;
	const indexAttr = geometry.index;
	const posAttr = geometry.attributes.position;
	const normalAttr = geometry.attributes.normal;

	_inverseMatrix.copy( targetMesh.matrixWorld ).invert();
	_sphere.center.copy( point ).applyMatrix4( _inverseMatrix );
	_sphere.radius = params.size;

	// Collect the intersected vertices
	const indices = new Set();
	const triangles = new Set();
	const bvh = geometry.boundsTree;
	bvh.shapecast( {

		intersectsBounds: ( box, isLeaf, score, depth, nodeIndex ) => {

			const intersects = _sphere.intersectsBox( box );
			if ( ! intersects ) {

				return NOT_INTERSECTED;

			}

			// only track nodes that actually intersect the brush. Including
			// non-intersecting frontier nodes would make refit() traverse and
			// update their entire subtrees, which dominates the frame time on
			// high poly meshes.
			accumulatedTraversedNodeIndices.add( nodeIndex );

			const { min, max } = box;
			for ( let x = 0; x <= 1; x ++ ) {

				for ( let y = 0; y <= 1; y ++ ) {

					for ( let z = 0; z <= 1; z ++ ) {

						_tempVec.set(
							x === 0 ? min.x : max.x,
							y === 0 ? min.y : max.y,
							z === 0 ? min.z : max.z
						);
						if ( ! _sphere.containsPoint( _tempVec ) ) {

							return INTERSECTED;

						}

					}

				}

			}

			return CONTAINED;

		},

		intersectsTriangle: ( tri, index, contained ) => {

			const triIndex = index;
			triangles.add( triIndex );
			accumulatedTriangles.add( triIndex );

			const i3 = 3 * index;
			const a = i3 + 0;
			const b = i3 + 1;
			const c = i3 + 2;
			const va = indexAttr.getX( a );
			const vb = indexAttr.getX( b );
			const vc = indexAttr.getX( c );
			if ( contained ) {

				indices.add( va );
				indices.add( vb );
				indices.add( vc );

				accumulatedIndices.add( va );
				accumulatedIndices.add( vb );
				accumulatedIndices.add( vc );

			} else {

				if ( _sphere.containsPoint( tri.a ) ) {

					indices.add( va );
					accumulatedIndices.add( va );

				}

				if ( _sphere.containsPoint( tri.b ) ) {

					indices.add( vb );
					accumulatedIndices.add( vb );

				}

				if ( _sphere.containsPoint( tri.c ) ) {

					indices.add( vc );
					accumulatedIndices.add( vc );

				}

			}

			return false;

		}

	} );

	// Compute the average normal at this point
	_localPoint.copy( point ).applyMatrix4( _inverseMatrix );

	_planePoint.set( 0, 0, 0 );
	_normal.set( 0, 0, 0 );
	let totalPoints = 0;
	indices.forEach( index => {

		_tempVec.fromBufferAttribute( normalAttr, index );
		_normal.add( _tempVec );

		// compute the average point for cases where we need to flatten
		// to the plane.
		if ( ! brushOnly ) {

			totalPoints ++;
			_tempVec.fromBufferAttribute( posAttr, index );
			_planePoint.add( _tempVec );

		}

	} );
	_normal.normalize();
	brushObject.quaternion.setFromUnitVectors( normalZ, _normal );

	if ( totalPoints ) {

		_planePoint.multiplyScalar( 1 / totalPoints );

	}

	// Early out if we just want to adjust the brush
	if ( brushOnly ) {

		return false;

	}

	// perform vertex adjustment
	const targetHeight = params.intensity * 0.0001;
	_plane.setFromNormalAndCoplanarPoint( _normal, _planePoint );

	if ( params.brush === 'smooth' ) {

		applySmoothBrush( indices );

	} else {

		indices.forEach( index => {

			_tempVec.fromBufferAttribute( posAttr, index );

			// compute the offset intensity
			const dist = _tempVec.distanceTo( _localPoint );
			const negated = params.invert !== rightClick ? - 1 : 1;
			let intensity = 1.0 - ( dist / params.size );

			if ( params.brush === 'mask' ) {

				// paint the mask instead of moving vertices
				recordMaskValue( index );
				const m = maskAttr.getX( index ) + negated * params.intensity * 0.01 * intensity;
				maskAttr.setX( index, Math.min( Math.max( m, 0 ), 1 ) );
				updateMaskColor( index );
				accumulatedMaskIndices.add( index );
				return;

			}

			// masked vertices can't be moved by other brushes
			const maskFactor = 1.0 - maskAttr.getX( index );
			if ( maskFactor <= 0.0 ) {

				return;

			}

			recordPosition( index );

			// offset the vertex
			if ( params.brush === 'clay' ) {

				intensity = Math.pow( intensity, 3 );
				const planeDist = _plane.distanceToPoint( _tempVec );
				const clampedIntensity = negated * Math.min( intensity * 4, 1.0 ) * maskFactor;
				_tempVec.addScaledVector( _normal, clampedIntensity * targetHeight - negated * planeDist * clampedIntensity * 0.3 );

			} else if ( params.brush === 'normal' ) {

				intensity = Math.pow( intensity, 2 );
				_tempVec.addScaledVector( _normal, negated * intensity * targetHeight * maskFactor );

			} else if ( params.brush === 'flatten' ) {

				intensity = Math.pow( intensity, 2 );

				const planeDist = _plane.distanceToPoint( _tempVec );
				_tempVec.addScaledVector( _normal, - planeDist * intensity * params.intensity * 0.01 * 0.5 * maskFactor );

			}

			posAttr.setXYZ( index, _tempVec.x, _tempVec.y, _tempVec.z );
			normalAttr.setXYZ( index, 0, 0, 0 );

		} );

	}

	return params.brush !== 'mask';

}

function updateNormals( triangles, indices ) {

	const indexAttr = targetMesh.geometry.index;
	const posAttr = targetMesh.geometry.attributes.position;
	const normalAttr = targetMesh.geometry.attributes.normal;

	// accumulate the normals in place in the normal buffer
	triangles.forEach( tri => {

		const tri3 = tri * 3;
		const i0 = tri3 + 0;
		const i1 = tri3 + 1;
		const i2 = tri3 + 2;

		const v0 = indexAttr.getX( i0 );
		const v1 = indexAttr.getX( i1 );
		const v2 = indexAttr.getX( i2 );

		_triangle.a.fromBufferAttribute( posAttr, v0 );
		_triangle.b.fromBufferAttribute( posAttr, v1 );
		_triangle.c.fromBufferAttribute( posAttr, v2 );
		_triangle.getNormal( _tempVec2 );

		if ( indices.has( v0 ) ) {

			_tempVec.fromBufferAttribute( normalAttr, v0 );
			_tempVec.add( _tempVec2 );
			normalAttr.setXYZ( v0, _tempVec.x, _tempVec.y, _tempVec.z );

		}

		if ( indices.has( v1 ) ) {

			_tempVec.fromBufferAttribute( normalAttr, v1 );
			_tempVec.add( _tempVec2 );
			normalAttr.setXYZ( v1, _tempVec.x, _tempVec.y, _tempVec.z );

		}

		if ( indices.has( v2 ) ) {

			_tempVec.fromBufferAttribute( normalAttr, v2 );
			_tempVec.add( _tempVec2 );
			normalAttr.setXYZ( v2, _tempVec.x, _tempVec.y, _tempVec.z );

		}

	} );

	// normalize the accumulated normals
	indices.forEach( index => {

		_tempVec.fromBufferAttribute( normalAttr, index );
		_tempVec.normalize();
		normalAttr.setXYZ( index, _tempVec.x, _tempVec.y, _tempVec.z );

	} );

}

function updateStatsPanel( now ) {

	if ( now - lastStatsUpdate < 250 ) {

		return;

	}

	lastStatsUpdate = now;
	const triCount = targetMesh.geometry.index.count / 3;
	const vertCount = targetMesh.geometry.attributes.position.count;
	statsPanel.textContent =
		`${ triCount.toLocaleString() } tris · ${ vertCount.toLocaleString() } verts · ` +
		`${ ( 1000 / frameTimeMs ).toFixed( 0 ) } fps · ` +
		`stroke ${ strokeTimeMs.toFixed( 2 ) } ms · refit ${ refitTimeMs.toFixed( 2 ) } ms · ` +
		`undo ${ undoStack.length }/${ MAX_HISTORY_STEPS }`;

}

function render() {

	stats.begin();

	material.matcap = matcaps[ params.matcap ];

	const now = performance.now();
	if ( lastFrameTime ) {

		frameTimeMs = frameTimeMs * 0.95 + ( now - lastFrameTime ) * 0.05;

	}

	lastFrameTime = now;

	if ( controls.active || ! brushActive ) {

		// If the controls are being used then don't perform the strokes
		brush.visible = false;
		symmetryBrush.visible = false;
		lastCastPose.setScalar( Infinity );

	} else {

		_raycaster.setFromCamera( mouse, camera );
		_raycaster.firstHitOnly = true;

		const hit = _raycaster.intersectObject( targetMesh, true )[ 0 ];
		// if we hit the target mesh
		if ( hit ) {

			brush.visible = true;
			brush.scale.set( params.size, params.size, 0.1 );
			brush.position.copy( hit.point );

			symmetryBrush.visible = params.symmetrical;
			symmetryBrush.scale.set( params.size, params.size, 0.1 );
			symmetryBrush.position.copy( hit.point );
			symmetryBrush.position.x *= - 1;

			controls.enabled = false;

			// if the last cast pose was missed in the last frame then set it to
			// the current point so we don't streak across the surface
			if ( lastCastPose.x === Infinity ) {

				lastCastPose.copy( hit.point );

			}

			// If the mouse isn't pressed don't perform the stroke
			if ( ! ( mouseState || lastMouseState ) ) {

				performStroke( hit.point, brush, true );
				if ( params.symmetrical ) {

					hit.point.x *= - 1;
					performStroke( hit.point, symmetryBrush, true );
					hit.point.x *= - 1;

				}

				lastMouse.copy( mouse );
				lastCastPose.copy( hit.point );

			} else {

				// compute the distance the mouse moved and that the cast point moved
				const mdx = ( mouse.x - lastMouse.x ) * window.innerWidth * window.devicePixelRatio;
				const mdy = ( mouse.y - lastMouse.y ) * window.innerHeight * window.devicePixelRatio;
				let mdist = Math.sqrt( mdx * mdx + mdy * mdy );
				let castDist = hit.point.distanceTo( lastCastPose );

				const step = params.size * 0.15;
				const percent = Math.max( step / castDist, 1 / params.maxSteps );
				const mstep = mdist * percent;
				let stepCount = 0;

				// perform multiple iterations toward the current mouse pose for a consistent stroke
				// TODO: recast here so he cursor is on the surface of the model which requires faster
				// refitting of the model
				const changedTriangles = new Set();
				const changedIndices = new Set();
				const changedMaskIndices = new Set();
				const traversedNodeIndices = new Set();
				const sets = {

					accumulatedTriangles: changedTriangles,
					accumulatedIndices: changedIndices,
					accumulatedTraversedNodeIndices: traversedNodeIndices,
					accumulatedMaskIndices: changedMaskIndices,

				};

				const strokeStart = performance.now();
				let positionsChanged = false;
				while ( castDist > step && mdist > params.size * 200 / hit.distance ) {

					lastMouse.lerp( mouse, percent );
					lastCastPose.lerp( hit.point, percent );
					castDist -= step;
					mdist -= mstep;

					positionsChanged = performStroke( lastCastPose, brush, false, sets ) || positionsChanged;

					if ( params.symmetrical ) {

						lastCastPose.x *= - 1;
						positionsChanged = performStroke( lastCastPose, symmetryBrush, false, sets ) || positionsChanged;
						lastCastPose.x *= - 1;

					}

					stepCount ++;
					if ( stepCount > params.maxSteps ) {

						break;

					}

				}

				// refit the bounds and update the normals if we adjusted the mesh
				if ( stepCount > 0 ) {

					// refit bounds and normal updates could happen after every stroke
					// so it's up to date for the next one because both of those are used when updating
					// the model but it's faster to do them here.
					if ( positionsChanged ) {

						updateNormals( changedTriangles, changedIndices );

						// only upload the buffer ranges that actually changed
						const posAttr = targetMesh.geometry.attributes.position;
						const normalAttr = targetMesh.geometry.attributes.normal;
						addAttributeRanges( posAttr, changedIndices );
						addAttributeRanges( normalAttr, changedIndices );
						posAttr.needsUpdate = true;
						normalAttr.needsUpdate = true;

						const refitStart = performance.now();
						targetMesh.geometry.boundsTree.refit( traversedNodeIndices );
						refitTimeMs = performance.now() - refitStart;

						if ( bvhHelper.parent !== null ) {

							bvhHelper.update();

						}

					}

					if ( changedMaskIndices.size ) {

						addAttributeRanges( maskAttr, changedMaskIndices );
						addAttributeRanges( colorAttr, changedMaskIndices );
						maskAttr.needsUpdate = true;
						colorAttr.needsUpdate = true;

					}

					strokeTimeMs = performance.now() - strokeStart;

				} else {

					performStroke( hit.point, brush, true );
					if ( params.symmetrical ) {

						hit.point.x *= - 1;
						performStroke( hit.point, symmetryBrush, true );
						hit.point.x *= - 1;

					}

				}

			}

		} else {

			// if we didn't hit
			controls.enabled = true;
			brush.visible = false;
			symmetryBrush.visible = false;
			lastMouse.copy( mouse );
			lastCastPose.setScalar( Infinity );

		}

	}

	lastMouseState = mouseState;

	renderer.render( scene, camera );
	stats.end();

	updateStatsPanel( now );

}

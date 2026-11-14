import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import Stats from 'stats.js';
import { GUI } from 'three/examples/jsm/libs/lil-gui.module.min.js';
import { MeshBVH, sliceMesh, sectionToSVG } from 'three-mesh-bvh';

const params = {

	model: 'Torus Knot',
	layerHeight: 0.08,
	layerIndex: 20,
	displayModel: true,
	displayCap: true,
	displayLines: true,
	animate: false,
	exportSVG: () => exportCurrentLayerSVG(),

};

const modelFactories = {

	'Torus Knot': () => new THREE.TorusKnotGeometry( 0.35, 0.12, 220, 32 ),
	'Torus': () => new THREE.TorusGeometry( 0.4, 0.16, 32, 64 ),
	'Sphere': () => new THREE.SphereGeometry( 0.5, 96, 64 ),
	'Boxes': () => createMultiBoxGeometry(),

};

let renderer, camera, scene, gui, stats, controls;
let bvh = null;
let geometry = null;
let bounds = new THREE.Box3();
let capMesh = null;
let outlineLines = null;
let planeMesh = null;
let lastSliceKey = '';
let outputElement = null;
let layerIndexController = null;

const slicePlane = new THREE.Plane( new THREE.Vector3( 0, 1, 0 ), 0 );

init();

function init() {

	outputElement = document.getElementById( 'output' );

	const bgColor = new THREE.Color( 0x263238 ).multiplyScalar( 0.1 );

	renderer = new THREE.WebGLRenderer( { antialias: true } );
	renderer.setPixelRatio( window.devicePixelRatio );
	renderer.setSize( window.innerWidth, window.innerHeight );
	renderer.setClearColor( bgColor, 1 );
	renderer.setAnimationLoop( render );
	document.body.appendChild( renderer.domElement );

	scene = new THREE.Scene();
	scene.fog = new THREE.Fog( bgColor, 20, 70 );

	scene.add( new THREE.DirectionalLight( 0xffffff, 2.5 ) );
	scene.add( new THREE.HemisphereLight( 0xffffff, 0x223344, 1.5 ) );

	camera = new THREE.PerspectiveCamera( 75, window.innerWidth / window.innerHeight, 0.01, 50 );
	camera.position.set( 1.2, 0.8, 1.2 );

	controls = new OrbitControls( camera, renderer.domElement );

	// cap mesh - geometry is replaced on every slice
	capMesh = new THREE.Mesh(
		new THREE.BufferGeometry(),
		new THREE.MeshStandardMaterial( {
			color: 0x80deea,
			roughness: 0.6,
			metalness: 0.1,
			side: THREE.DoubleSide,
			transparent: true,
			opacity: 0.85,
		} ),
	);
	capMesh.renderOrder = 2;
	scene.add( capMesh );

	outlineLines = new THREE.LineSegments(
		new THREE.BufferGeometry(),
		new THREE.LineBasicMaterial( { color: 0x00acc1 } ),
	);
	outlineLines.renderOrder = 3;
	scene.add( outlineLines );

	planeMesh = new THREE.Mesh(
		new THREE.PlaneGeometry( 2, 2 ),
		new THREE.MeshBasicMaterial( {
			color: 0x80deea,
			transparent: true,
			opacity: 0.08,
			side: THREE.DoubleSide,
			depthWrite: false,
		} ),
	);
	planeMesh.rotation.x = - Math.PI / 2;
	scene.add( planeMesh );

	buildModel( params.model );

	gui = new GUI();
	const modelFolder = gui.addFolder( 'model' );
	modelFolder.add( params, 'model', Object.keys( modelFactories ) ).onChange( buildModel );
	modelFolder.add( params, 'displayModel' );
	modelFolder.open();

	const sliceFolder = gui.addFolder( 'slice' );
	sliceFolder.add( params, 'layerHeight', 0.01, 0.4, 0.005 ).name( 'layer height' ).onChange( () => {

		// the number of layers depends on the layer height, so keep the index in range
		params.layerIndex = Math.min( params.layerIndex, getMaxLayerIndex() );
		if ( layerIndexController ) {

			layerIndexController.max( getMaxLayerIndex() );

		}

		layerIndexController?.updateDisplay();

	} );
	layerIndexController = sliceFolder.add( params, 'layerIndex', 0, 100, 1 ).name( 'layer index' );
	sliceFolder.add( params, 'displayCap' ).name( 'show cap' );
	sliceFolder.add( params, 'displayLines' ).name( 'show lines' );
	sliceFolder.add( params, 'animate' ).name( 'auto play' );
	sliceFolder.add( params, 'exportSVG' ).name( 'export layer SVG' );
	sliceFolder.open();

	stats = new Stats();
	document.body.appendChild( stats.dom );

	window.addEventListener( 'resize', () => {

		camera.aspect = window.innerWidth / window.innerHeight;
		camera.updateProjectionMatrix();
		renderer.setSize( window.innerWidth, window.innerHeight );
		renderer.setPixelRatio( window.devicePixelRatio );

	} );

}

function buildModel( name ) {

	if ( geometry ) {

		geometry.dispose();

	}

	geometry = modelFactories[ name ]();

	bounds.setFromBufferAttribute( geometry.attributes.position );
	const size = new THREE.Vector3();
	bounds.getSize( size );
	const center = new THREE.Vector3();
	bounds.getCenter( center );

	// center the geometry at the origin so layers run from the bottom of the model. Build the
	// BVH after the transform so the tree matches the final vertex positions directly.
	geometry.translate( - center.x, - center.y, - center.z );
	bounds.setFromBufferAttribute( geometry.attributes.position );
	bounds.getSize( size );

	bvh = new MeshBVH( geometry, { targetLeafSize: 8 } );
	geometry.boundsTree = bvh;

	const model = new THREE.Mesh(
		geometry,
		new THREE.MeshStandardMaterial( {
			color: 0xffffff,
			roughness: 0.8,
			metalness: 0.0,
			polygonOffset: true,
			polygonOffsetFactor: 1,
			polygonOffsetUnits: 1,
		} ),
	);
	scene.children.filter( c => c.userData.isModel ).forEach( c => {

		c.geometry.dispose();
		scene.remove( c );

	} );
	model.userData.isModel = true;
	scene.add( model );

	// size the preview plane to the model footprint
	const footprint = Math.max( size.x, size.z ) * 1.2;
	planeMesh.scale.setScalar( footprint );

	params.layerIndex = Math.min( params.layerIndex, getMaxLayerIndex() );
	if ( layerIndexController ) {

		layerIndexController.max( getMaxLayerIndex() );

	}

	gui.controllersRecursive().forEach( controller => controller.updateDisplay() );
	lastSliceKey = '';

}

function getMaxLayerIndex() {

	if ( ! bounds ) {

		return 0;

	}

	const height = bounds.max.y - bounds.min.y;
	return Math.max( 0, Math.ceil( height / params.layerHeight ) - 1 );

}

function getLayerHeightWorld() {

	return bounds.min.y + params.layerIndex * params.layerHeight + params.layerHeight / 2;

}

function updateSlice() {

	if ( ! bvh ) {

		return;

	}

	// keep the layer index inside the model as the layer height changes
	const maxIndex = getMaxLayerIndex();
	if ( params.layerIndex > maxIndex ) {

		params.layerIndex = maxIndex;

	}

	const height = getLayerHeightWorld();
	const sliceKey = `${ params.layerIndex }:${ params.layerHeight.toFixed( 5 ) }:${ params.model }`;
	if ( sliceKey === lastSliceKey ) {

		return;

	}

	lastSliceKey = sliceKey;

	// plane with normal +Y and constant -height (plane: normal * p + constant = 0)
	slicePlane.normal.set( 0, 1, 0 );
	slicePlane.constant = - height;

	const startTime = window.performance.now();
	const section = sliceMesh( bvh, slicePlane );
	const sliceMs = window.performance.now() - startTime;

	// update cap
	const capGeometry = section.toGeometry();
	const oldCap = capMesh.geometry;
	if ( capGeometry ) {

		capMesh.geometry = capGeometry;
		if ( oldCap && oldCap !== capGeometry ) {

			oldCap.dispose();

		}

	} else {

		capMesh.geometry = new THREE.BufferGeometry();
		if ( oldCap ) {

			oldCap.dispose();

		}

	}

	capMesh.visible = params.displayCap;

	// update outline line segments from the raw contours
	const linePositions = [];
	const pushLoop = loop => {

		for ( let i = 0, l = loop.length; i < l; i ++ ) {

			const a = section.points[ loop[ i ] ];
			const b = section.points[ loop[ ( i + 1 ) % l ] ];
			linePositions.push( a.x, a.y, a.z, b.x, b.y, b.z );

		}

	};

	section.contours.forEach( contour => pushLoop( contour.points ) );
	section.openContours.forEach( loop => {

		for ( let i = 0, l = loop.length - 1; i < l; i ++ ) {

			const a = section.points[ loop[ i ] ];
			const b = section.points[ loop[ i + 1 ] ];
			linePositions.push( a.x, a.y, a.z, b.x, b.y, b.z );

		}

	} );

	const oldLineGeometry = outlineLines.geometry;
	const lineGeometry = new THREE.BufferGeometry();
	lineGeometry.setAttribute(
		'position',
		new THREE.BufferAttribute( new Float32Array( linePositions ), 3 ),
	);
	outlineLines.geometry = lineGeometry;
	oldLineGeometry.dispose();
	outlineLines.visible = params.displayLines;

	// move the translucent preview plane
	planeMesh.position.set( 0, height, 0 );

	outputElement.innerText =
		`layer ${ params.layerIndex } / ${ maxIndex }\n` +
		`height: ${ height.toFixed( 4 ) }\n` +
		`contours: ${ section.contours.length } (holes: ${ section.contours.filter( c => c.hole ).length })\n` +
		`points: ${ section.points.length }\n` +
		`slice: ${ sliceMs.toFixed( 2 ) }ms`;

	// stash the latest section for the SVG export button
	capMesh.userData.section = section;

}

function exportCurrentLayerSVG() {

	const section = capMesh.userData.section;
	if ( ! section || section.contours.length === 0 ) {

		outputElement.innerText += '\nNo slice to export.';
		return;

	}

	const svg = sectionToSVG( section, { precision: 5 } );
	const blob = new Blob( [ svg ], { type: 'image/svg+xml' } );
	const url = URL.createObjectURL( blob );
	const link = document.createElement( 'a' );
	link.href = url;
	link.download = `slice-layer-${ params.layerIndex }.svg`;
	link.click();
	URL.revokeObjectURL( url );

}

function createMultiBoxGeometry() {

	// a few overlapping boxes so the slice has multiple regions and holes
	const geometries = [
		new THREE.BoxGeometry( 0.8, 1.0, 0.8 ),
		new THREE.BoxGeometry( 0.5, 0.7, 0.5 ).translate( 0.25, 0.0, 0.25 ),
		new THREE.BoxGeometry( 0.3, 1.2, 0.3 ).translate( - 0.3, 0.0, - 0.3 ),
	];
	const merged = mergeGeometries( geometries );
	geometries.forEach( g => g.dispose() );
	return merged;

}

function mergeGeometries( geometries ) {

	// minimal non-indexed merge so the example does not need BufferGeometryUtils
	const positions = [];
	for ( const g of geometries ) {

		const gIndexed = g.index ? g.toNonIndexed() : g;
		const array = gIndexed.attributes.position.array;
		for ( let i = 0; i < array.length; i ++ ) {

			positions.push( array[ i ] );

		}

		if ( gIndexed !== g ) {

			gIndexed.dispose();

		}

	}

	const merged = new THREE.BufferGeometry();
	merged.setAttribute( 'position', new THREE.BufferAttribute( new Float32Array( positions ), 3 ) );
	return merged;

}

function render() {

	if ( params.animate ) {

		params.layerIndex = ( params.layerIndex + 1 ) % ( getMaxLayerIndex() + 1 );
		gui.controllersRecursive().forEach( controller => controller.updateDisplay() );

	}

	// keep the model visibility in sync with the gui option
	scene.children.forEach( child => {

		if ( child.userData.isModel ) {

			child.visible = params.displayModel;

		}

	} );

	updateSlice();
	controls.update();
	stats.update();
	renderer.render( scene, camera );

}

import {
	AnimationMixer,
	Box3,
	Plane,
	Vector3,
	MeshBasicMaterial,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { SkinnedMeshBVH, sliceMesh } from 'three-mesh-bvh';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

// GLTFLoader accesses `self` and `self.URL` when building object URLs for embedded textures
globalThis.self = globalThis;

// ImageBitmapLoader calls createImageBitmap on the fetched blob; stub it so no canvas is needed
globalThis.createImageBitmap = async () => ( { width: 1, height: 1, close() {} } );

const __dirname = path.dirname( fileURLToPath( import.meta.url ) );
const glbPath = path.join( __dirname, 'data', 'Soldier.glb' );

function loadModel() {

	return new Promise( ( resolve, reject ) => {

		const data = fs.readFileSync( glbPath );
		const loader = new GLTFLoader();
		loader.parse( data.buffer, '', resolve, reject );

	} );

}

describe( 'SectionUtilities with SkinnedMeshBVH', () => {

	let skinnedMesh = null;
	let bvh = null;

	beforeAll( async () => {

		const gltf = await loadModel();
		gltf.scene.traverse( child => {

			if ( child.isSkinnedMesh && ! skinnedMesh ) {

				child.material = new MeshBasicMaterial();
				skinnedMesh = child;

			}

		} );

		// pose the skeleton so the slice intersects a meaningful part of the body
		const mixer = new AnimationMixer( gltf.scene );
		mixer.clipAction( gltf.animations[ 1 ] ).play();
		mixer.update( 0.5 );
		gltf.scene.updateMatrixWorld( true );

		bvh = new SkinnedMeshBVH( skinnedMesh );

	} );

	const midPlane = () => {

		const box = bvh.getBoundingBox( new Box3() );
		const height = ( box.min.y + box.max.y ) * 0.5;
		return new Plane( new Vector3( 0, 1, 0 ), - height );

	};

	it( 'slices a posed skinned mesh through the shared shapecast interface', () => {

		expect( bvh ).toBeTruthy();

		const plane = midPlane();
		const section = sliceMesh( bvh, plane );

		// the posed soldier body must intersect the mid-height plane
		expect( section.triangleCount ).toBeGreaterThan( 0 );
		expect( section.points.length ).toBeGreaterThan( 0 );
		expect( section.contours.length ).toBeGreaterThan( 0 );

		// every generated point lies on the slice plane
		for ( const point of section.points ) {

			expect( Math.abs( plane.distanceToPoint( point ) ) ).toBeLessThan( 1e-4 );

		}

		// all contours are closed and reference welded, existing points
		for ( const contour of section.contours ) {

			expect( contour.points.length ).toBeGreaterThanOrEqual( 3 );
			for ( const id of contour.points ) {

				expect( section.points[ id ] ).toBeDefined();

			}

		}

	} );

	it( 'produces a capped geometry for the skinned mesh slice', () => {

		const section = sliceMesh( bvh, midPlane() );
		const cap = section.toGeometry();

		expect( cap ).not.toBeNull();
		expect( cap.index.count ).toBeGreaterThan( 0 );
		expect( cap.index.count % 3 ).toBe( 0 );
		expect( cap.attributes.normal ).toBeDefined();

	} );

	it( 'keeps slicing usable after a refit', () => {

		const before = sliceMesh( bvh, midPlane() );
		expect( before.triangleCount ).toBeGreaterThan( 0 );

		expect( () => {

			bvh.refit();
			const after = sliceMesh( bvh, midPlane() );
			expect( after.triangleCount ).toBeGreaterThan( 0 );
			expect( after.points.length ).toBeGreaterThan( 0 );
			expect( after.contours.length ).toBeGreaterThan( 0 );

		} ).not.toThrow();

	} );

} );

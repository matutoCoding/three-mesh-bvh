import { BufferGeometry, Mesh, Plane, Raycaster, BatchedMesh, Vector3 } from 'three';
import {
	acceleratedRaycast,
	computeBoundsTree,
	disposeBoundsTree,
	computeBatchedBoundsTree,
	disposeBatchedBoundsTree,
	sliceMesh,
	sectionToSVG,
	Section,
} from 'three-mesh-bvh';

Mesh.prototype.raycast = acceleratedRaycast;
BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;

BatchedMesh.prototype.raycast = acceleratedRaycast;
BatchedMesh.prototype.computeBoundsTree = computeBatchedBoundsTree;
BatchedMesh.prototype.disposeBoundsTree = disposeBatchedBoundsTree;

const mesh = new Mesh();
mesh.geometry.computeBoundsTree();
mesh.geometry.disposeBoundsTree();

const batchedMesh = new BatchedMesh( 1, 1, 1 );
batchedMesh.computeBoundsTree();
batchedMesh.disposeBoundsTree();

const raycaster = new Raycaster();
raycaster.firstHitOnly = true;

mesh.raycast( raycaster, [] );

// slicing API type checks
const slicePlane = new Plane( new Vector3( 0, 1, 0 ), 0 );
const bvh = mesh.geometry.boundsTree;
if ( bvh ) {

	const section: Section = sliceMesh( bvh, slicePlane, { epsilon: 1e-10, includeCoplanarFaces: false } );
	const cap: BufferGeometry | null = section.toGeometry();
	const svg: string = sectionToSVG( section, { precision: 4, fill: 'red', stroke: 'blue' } );
	const contourCount: number = section.contours.length;
	const openCount: number = section.openContours.length;
	void cap;
	void svg;
	void contourCount;
	void openCount;

}

import * as streamline from "./streamlineIO.mjs";
import * as fs from "fs";
import * as path from "path";
import assert from "assert";

function assertCloseTo(actual, expected, eps = 1e-3, message = "") {
  const diff = Math.abs(actual - expected);
  if (diff > eps) {
    throw new Error(
      `${message} Expected ${expected} but got ${actual} (diff: ${diff} > eps ${eps})`,
    );
  }
}

function assertArrayCloseTo(actual, expected, eps = 1e-3, message = "") {
  assert.strictEqual(
    actual.length,
    expected.length,
    `${message} Array length mismatch: ${actual.length} vs ${expected.length}`,
  );
  for (let i = 0; i < actual.length; i++) {
    assertCloseTo(actual[i], expected[i], eps, `${message} at index ${i}`);
  }
}

async function runTests() {
  console.log("Loading test_data/gs.* files...");
  const testDataDir = path.resolve("./test_data");

  const trkBuf = fs.readFileSync(path.join(testDataDir, "gs.trk"));
  const tckBuf = fs.readFileSync(path.join(testDataDir, "gs.tck"));
  const vtkBuf = fs.readFileSync(path.join(testDataDir, "gs.vtk"));
  const trxPath = path.join(testDataDir, "gs.trx");

  const trk = streamline.readTRK(new Uint8Array(trkBuf).buffer);
  const tck = streamline.readTCK(new Uint8Array(tckBuf).buffer);
  const vtk = streamline.readVTK(new Uint8Array(vtkBuf).buffer);
  const trx = await streamline.readTRX(trxPath, true);

  console.log("1. Testing Streamline & Vertex counts...");
  const trkStreamlines = trk.offsetPt0.length - 1;
  const tckStreamlines = tck.offsetPt0.length - 1;
  const vtkStreamlines = vtk.offsetPt0.length - 1;
  const trxStreamlines = trx.offsetPt0.length - 1;

  assert.strictEqual(trkStreamlines, 13, "TRK streamline count");
  assert.strictEqual(tckStreamlines, 13, "TCK streamline count");
  assert.strictEqual(vtkStreamlines, 13, "VTK streamline count");
  assert.strictEqual(trxStreamlines, 13, "TRX streamline count");

  const trkVertices = trk.pts.length / 3;
  const tckVertices = tck.pts.length / 3;
  const vtkVertices = vtk.pts.length / 3;
  const trxVertices = trx.pts.length / 3;

  assert.strictEqual(trkVertices, 104, "TRK vertex count");
  assert.strictEqual(tckVertices, 104, "TCK vertex count");
  assert.strictEqual(vtkVertices, 104, "VTK vertex count");
  assert.strictEqual(trxVertices, 104, "TRX vertex count");

  console.log("2. Testing Streamline offset arrays (offsetPt0)...");
  assert.deepStrictEqual(
    Array.from(trk.offsetPt0),
    Array.from(tck.offsetPt0),
    "TRK vs TCK offsets",
  );
  assert.deepStrictEqual(
    Array.from(trk.offsetPt0),
    Array.from(vtk.offsetPt0),
    "TRK vs VTK offsets",
  );
  assert.deepStrictEqual(
    Array.from(trk.offsetPt0),
    Array.from(trx.offsetPt0),
    "TRK vs TRX offsets",
  );

  console.log("3. Testing Header dimensions and VOXEL_TO_RASMM affines...");
  assert.deepStrictEqual(trk.header.DIMENSIONS, [5, 10, 20], "TRK DIMENSIONS");
  assert.deepStrictEqual(trx.header.DIMENSIONS, [5, 10, 20], "TRX DIMENSIONS");

  for (let r = 0; r < 4; r++) {
    assertArrayCloseTo(
      trk.header.VOXEL_TO_RASMM[r],
      trx.header.VOXEL_TO_RASMM[r],
      1e-3,
      `VOXEL_TO_RASMM row ${r}`,
    );
  }

  console.log("4. Testing Point coordinates (pts) across formats...");
  for (let i = 0; i < trk.pts.length; i++) {
    assertCloseTo(trk.pts[i], tck.pts[i], 1e-3, `TRK vs TCK point ${i}`);
    assertCloseTo(trk.pts[i], trx.pts[i], 1e-3, `TRK vs TRX point ${i}`);
    // VTK uses LPS orientation (negated X and Y relative to RAS)
    const vtkVal = i % 3 === 0 || i % 3 === 1 ? -vtk.pts[i] : vtk.pts[i];
    assertCloseTo(trk.pts[i], vtkVal, 1e-3, `TRK vs VTK point ${i}`);
  }

  console.log("5. Testing Per-Vertex Metadata (dpv)...");
  const getDpv = (container, id) => container.dpv.find((d) => d.id === id);

  for (const key of ["color_x", "color_y", "color_z"]) {
    const trkDpv = getDpv(trk, key);
    const trxDpv = getDpv(trx, key);
    assert.ok(trkDpv, `TRK missing dpv key ${key}`);
    assert.ok(trxDpv, `TRX missing dpv key ${key}`);
    assertArrayCloseTo(trkDpv.vals, trxDpv.vals, 1e-3, `dpv.${key} values`);
  }

  console.log("6. Testing FD resource leak prevention...");
  // Open repeatedly to verify FDs are properly closed and do not hit limits
  for (let i = 0; i < 50; i++) {
    await streamline.readTRX(trxPath, true);
  }

  console.log("All gs.* format consistency tests passed successfully!");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});

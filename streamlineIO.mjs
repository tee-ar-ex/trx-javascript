
import { mat3, mat4, vec3, vec4 } from "gl-matrix"; //for trk
import * as fs from "fs";
import * as fflate from "fflate";
import * as fzstd from "fzstd"; //https://github.com/101arrowz/fzstd
import { crc32 as nativeCrc32 } from "node:zlib";

// ---------------------------------------------------------------------------
// Minimal one-sided Jacobi SVD for 3×3 real matrices.
// Returns { U, S, Vt } such that A ≈ U * diag(S) * Vt
// Used by axcodesFromAffine to replicate nibabel's io_orientation approach.
// ---------------------------------------------------------------------------
function _matMul3(A, B) {
    const C = [[0,0,0],[0,0,0],[0,0,0]];
    for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++)
            for (let k = 0; k < 3; k++)
                C[i][j] += A[i][k] * B[k][j];
    return C;
}

function _svd3(A) {
    // One-sided Jacobi SVD: iteratively zero off-diagonal elements of A^T A
    // via Givens rotations applied to the right (accumulating into Vt).
    const Vt = [[1,0,0],[0,1,0],[0,0,1]];
    const B  = A.map(r => [...r]);   // working copy

    for (let iter = 0; iter < 20; iter++) {
        let changed = false;
        for (let p = 0; p < 2; p++) {
            for (let q = p + 1; q < 3; q++) {
                let bpp = 0, bqq = 0, bpq = 0;
                for (let k = 0; k < 3; k++) {
                    bpp += B[k][p] * B[k][p];
                    bqq += B[k][q] * B[k][q];
                    bpq += B[k][p] * B[k][q];
                }
                if (Math.abs(bpq) < 1e-14 * Math.sqrt(bpp * bqq + 1e-300)) continue;
                changed = true;
                const tau = (bqq - bpp) / (2 * bpq);
                const t   = Math.sign(tau) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
                const c   = 1 / Math.sqrt(1 + t * t);
                const s   = t * c;
                // Apply Givens rotation to columns p,q of B
                for (let k = 0; k < 3; k++) {
                    const bp = B[k][p], bq = B[k][q];
                    B[k][p] =  c * bp + s * bq;
                    B[k][q] = -s * bp + c * bq;
                }
                // Accumulate rotation into Vt (rows of Vt = columns of V)
                for (let k = 0; k < 3; k++) {
                    const vp = Vt[p][k], vq = Vt[q][k];
                    Vt[p][k] =  c * vp + s * vq;
                    Vt[q][k] = -s * vp + c * vq;
                }
            }
        }
        if (!changed) break;
    }

    // Singular values = column norms of B; U = columns of B normalised
    const U = [[0,0,0],[0,0,0],[0,0,0]];
    const S = [0, 0, 0];
    for (let j = 0; j < 3; j++) {
        let norm = 0;
        for (let i = 0; i < 3; i++) norm += B[i][j] * B[i][j];
        norm = Math.sqrt(norm);
        S[j] = norm;
        for (let i = 0; i < 3; i++)
            U[i][j] = norm > 0 ? B[i][j] / norm : (i === j ? 1 : 0);
    }
    return { U, S, Vt };   // A ≈ U * diag(S) * Vt
}

/**
 * Derive the 3-character voxel_order string from a 4×4 affine (row-major
 * nested array), replicating nibabel.aff2axcodes / io_orientation exactly:
 *   1. Normalize columns of the 3×3 block by their L2 norm.
 *   2. SVD → R = U * Vt  (closest pure rotation, polar decomposition).
 *   3. Per-column argmax(|R|) with axis exclusion.
 */
function axcodesFromAffine(aff) {
    const POS = ['R', 'A', 'S'];
    const NEG = ['L', 'P', 'I'];

    // Step 1: column-normalised 3×3 block
    const rs = [[0,0,0],[0,0,0],[0,0,0]];
    for (let col = 0; col < 3; col++) {
        let norm = 0;
        for (let row = 0; row < 3; row++) norm += aff[row][col] ** 2;
        norm = Math.sqrt(norm) || 1;
        for (let row = 0; row < 3; row++) rs[row][col] = aff[row][col] / norm;
    }

    // Step 2: R = U * Vt
    const { U, Vt } = _svd3(rs);
    const R = _matMul3(U, Vt);

    // Step 3: argmax per column with axis exclusion
    const used = [false, false, false];
    let result = '';
    for (let col = 0; col < 3; col++) {
        let bestRow = 0, bestVal = -1;
        for (let row = 0; row < 3; row++) {
            if (!used[row] && Math.abs(R[row][col]) > bestVal) {
                bestVal = Math.abs(R[row][col]);
                bestRow = row;
            }
        }
        used[bestRow] = true;
        result += R[bestRow][col] >= 0 ? POS[bestRow] : NEG[bestRow];
    }
    return result;
}

function parseZipCentralDirectory(dataOrPath, isLocalFile) {
    let fd = null;
    let n = 0;
    let dataBuffer = null;

    if (isLocalFile) {
        fd = fs.openSync(dataOrPath, 'r');
        n = fs.fstatSync(fd).size;
    } else {
        dataBuffer = new Uint8Array(dataOrPath);
        n = dataBuffer.byteLength;
    }

    function readBytes(offset, length) {
        const buf = Buffer.alloc(length);
        if (isLocalFile) {
            fs.readSync(fd, buf, 0, length, offset);
        } else {
            buf.set(dataBuffer.subarray(offset, offset + length));
        }
        return buf;
    }

    const scanSize = Math.min(n, 65558);
    const scanBuf = readBytes(n - scanSize, scanSize);

    let eocd = -1;
    for (let i = scanSize - 22; i >= 0; i--) {
        if (scanBuf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }

    if (eocd === -1) { if (fd) fs.closeSync(fd); throw new Error("Not a ZIP file"); }

    let cdCount = scanBuf.readUInt16LE(eocd + 8);
    let cdOffset = scanBuf.readUInt32LE(eocd + 16);

    for (let i = eocd - 20; i >= 0; i--) {
        if (scanBuf.readUInt32LE(i) === 0x07064b50) {
            const eocd64off = Number(scanBuf.readBigUInt64LE(i + 8));
            const eocd64Buf = readBytes(eocd64off, 56);
            if (eocd64Buf.readUInt32LE(0) === 0x06064b50) {
                cdCount = Number(eocd64Buf.readBigUInt64LE(32));
                cdOffset = Number(eocd64Buf.readBigUInt64LE(48));
            }
            break;
        }
    }

    const cdSize = (n - scanSize + eocd) - cdOffset;
    const cdBuf = readBytes(cdOffset, cdSize);

    const files = {};
    let pos = 0;
    for (let i = 0; i < cdCount; i++) {
        if (pos + 46 > cdSize || cdBuf.readUInt32LE(pos) !== 0x02014b50) break;
        const compMethod = cdBuf.readUInt16LE(pos + 10);
        const compSize = cdBuf.readUInt32LE(pos + 20);
        let origSize = cdBuf.readUInt32LE(pos + 24);
        const fnLen = cdBuf.readUInt16LE(pos + 28);
        const exLen = cdBuf.readUInt16LE(pos + 30);
        const cmLen = cdBuf.readUInt16LE(pos + 32);
        let localHeaderOffset = cdBuf.readUInt32LE(pos + 42);

        const fname = cdBuf.toString('utf-8', pos + 46, pos + 46 + fnLen);

        if (origSize === 0xFFFFFFFF || localHeaderOffset === 0xFFFFFFFF) {
            let ep = pos + 46 + fnLen;
            const epEnd = ep + exLen;
            while (ep + 4 <= epEnd) {
                const tag = cdBuf.readUInt16LE(ep);
                const sz = cdBuf.readUInt16LE(ep + 2);
                if (tag === 0x0001 && sz >= 8) {
                    let fieldPos = ep + 4;
                    if (origSize === 0xFFFFFFFF) { origSize = Number(cdBuf.readBigUInt64LE(fieldPos)); fieldPos += 8; }
                    if (compSize === 0xFFFFFFFF) { fieldPos += 8; }
                    if (localHeaderOffset === 0xFFFFFFFF) { localHeaderOffset = Number(cdBuf.readBigUInt64LE(fieldPos)); }
                    break;
                }
                ep += 4 + sz;
            }
        }

        const lfhBuf = readBytes(localHeaderOffset, 30);
        const lfhFnLen = lfhBuf.readUInt16LE(26);
        const lfhExLen = lfhBuf.readUInt16LE(28);
        const dataOffset = localHeaderOffset + 30 + lfhFnLen + lfhExLen;

        files[fname] = {
            origSize,
            compMethod,
            dataOffset,
            compSize: (compSize === 0xFFFFFFFF && exLen > 0) ? undefined : compSize
        };

        pos += 46 + fnLen + exLen + cmLen;
    }

    if (fd) fs.closeSync(fd);
    return files;
}

//Install dependencies
// npm install gl-matrix fflate fzstd

/**
 * @typedef {Object} StreamlineData
 * @property {Float32Array} pts - Interleaved XYZ vertex positions for all streamlines.
 * @property {Uint32Array} offsetPt0 - Start index of each streamline in `pts` (NB_STREAMLINES+1 entries; the final entry solves the fencepost problem).
 * @property {Array<{id: string, vals: Float32Array|Uint32Array}>} [dps] - Data-per-streamline arrays (TRX, TRK).
 * @property {Array<{id: string, vals: Float32Array|Uint32Array}>} [dpv] - Data-per-vertex arrays (TRX, TRK).
 * @property {Array<{id: string, vals: Float32Array|Uint32Array}>} [dpg] - Data-per-group arrays (TRX only).
 * @property {Object} [header] - Parsed header.json contents (TRX only).
 */



//Read a Matlab V4 file, n.b. does not support modern versions
//https://www.mathworks.com/help/pdf_doc/matlab/matfile_format.pdf
function readMatV4(buffer) {
  let len = buffer.byteLength
  if (len < 40)
    throw new Error("File too small to be MAT v4: bytes = " + buffer.byteLength)
  let reader = new DataView(buffer)
  let magic = reader.getUint16(0, true)
  let _buffer = buffer
  if (magic === 35615 || magic === 8075) {
    // gzip signature 0x1F8B in little and big endian
    const raw = fflate.decompressSync(new Uint8Array(buffer))
    reader = new DataView(raw.buffer)
    magic = reader.getUint16(0, true)
    _buffer = raw.buffer
    len = _buffer.byteLength
  }
  const textDecoder = new TextDecoder('utf-8')
  let bytes = new Uint8Array(_buffer)
  let pos = 0
  let mat = []
  function getTensDigit(v) {
    return (Math.floor(v/10) % 10)
  }
  function readArray(tagDataType, tagBytesStart, tagBytesEnd) {
    const byteArray = new Uint8Array(bytes.subarray(tagBytesStart, tagBytesEnd))
    if (tagDataType === 1)
      return new Float32Array(byteArray.buffer)
    if (tagDataType === 2)
      return new Int32Array(byteArray.buffer)
    if (tagDataType === 3)
      return new Int16Array(byteArray.buffer)
    if (tagDataType === 4)
      return new Uint16Array(byteArray.buffer)
    if (tagDataType === 5)
      return new Uint8Array(byteArray.buffer)
    return new Float64Array(byteArray.buffer)
  }
  function readTag() {
    let mtype = reader.getUint32(pos, true)
    let mrows = reader.getUint32(pos+4, true)
    let ncols = reader.getUint32(pos+8, true)
    let imagf = reader.getUint32(pos+12, true)
    let namlen = reader.getUint32(pos+16, true)
    pos+= 20; //skip header
    if (imagf !== 0)
      throw new Error("Matlab V4 reader does not support imaginary numbers")
    let tagArrayItems = mrows * ncols
    if (tagArrayItems < 1)
      throw new Error("mrows * ncols must be greater than one")
    const byteArray = new Uint8Array(bytes.subarray(pos, pos+namlen))
    let tagName = textDecoder.decode(byteArray).trim().replaceAll('\x00','')
    let tagDataType = getTensDigit(mtype)
    //0 double-precision (64-bit) floating-point numbers
    //1 single-precision (32-bit) floating-point numbers
    //2 32-bit signed integers
    //3 16-bit signed integers
    //4 16-bit unsigned integers
    //5 8-bit unsigned integers
    let tagBytesPerItem = 8
    if ((tagDataType >= 1) && (tagDataType <= 2))
      tagBytesPerItem = 4
    else if ((tagDataType >= 3) && (tagDataType <= 4))
      tagBytesPerItem = 2
    else if (tagDataType === 5)
      tagBytesPerItem = 1
    else if (tagDataType !== 0)
      throw new Error("impossible Matlab v4 datatype")
    pos+= namlen; //skip name
    if (mtype > 50)
      throw new Error("Does not appear to be little-endian V4 Matlab file")
    let posEnd = pos + (tagArrayItems * tagBytesPerItem)
    mat[tagName] = readArray(tagDataType, pos, posEnd)
    pos = posEnd
  }
  while ((pos + 20) < len)
    readTag()
  return mat
} // readMatV4()

/**
 * Read a DSI Studio (.tt / .fib) file.
 *
 * Parses the Matlab V4 container, applies incremental zigzag decoding,
 * and transforms voxel coordinates to RAS (mm) space using the
 * `trans_to_mni` and `voxel_size` matrices.
 *
 * @param {ArrayBuffer} buffer - Raw file data (may be gzip-compressed; decompressed automatically).
 * @returns {StreamlineData} An object with `pts` and `offsetPt0`.
 */
 // https://dsi-studio.labsolver.org/doc/cli_data.html
 // https://brain.labsolver.org/hcp_trk_atlas.html
function readTT(buffer) {
  let offsetPt0 = []
  let pts = []
  const mat = readMatV4(buffer);
  if (!('trans_to_mni' in mat))
    throw new Error("TT format file must have 'trans_to_mni'")
  if (!('voxel_size' in mat))
    throw new Error("TT format file must have 'voxel_size'")
  if (!('track' in mat))
    throw new Error("TT format file must have 'track'")
  let trans_to_mni = mat4.create()
  let m = mat.trans_to_mni
  trans_to_mni = mat4.fromValues(m[0],m[1],m[2],m[3],  m[4],m[5],m[6],m[7],  m[8],m[9],m[10],m[11],  m[12],m[13],m[14],m[15])
  mat4.transpose(trans_to_mni, trans_to_mni)
  let zoomMat = mat4.create()
  zoomMat = mat4.fromValues(1 / mat.voxel_size[0],0,0,-0.5,
        0, 1 / mat.voxel_size[1], 0, -0.5,
        0, 0, 1 / mat.voxel_size[2], -0.5,
        0, 0, 0, 1)
  mat4.transpose(zoomMat, zoomMat)
  function parse_tt(track) {
    let dv = new DataView(track.buffer)
    let pos = []
    let nvert3 = 0
    let i = 0
    while(i < track.length) {
      pos.push(i)
      let newpts = dv.getUint32(i, true)
      i = i + newpts+13
      nvert3 += newpts
    }
    offsetPt0 = new Uint32Array(pos.length+1)
    pts = new Float32Array(nvert3)
    let npt = 0
    for (let i = 0; i < pos.length; i++) {
      offsetPt0[i] = npt / 3
      let p = pos[i]
      let sz = dv.getUint32(p, true)/3
      let x = dv.getInt32(p+4, true)
      let y = dv.getInt32(p+8, true)
      let z = dv.getInt32(p+12, true)
      p += 16
      pts[npt++] = x
      pts[npt++] = y
      pts[npt++] = z
      for (let j = 2; j <= sz; j++) {
          x = x + dv.getInt8(p++)
          y = y + dv.getInt8(p++)
          z = z + dv.getInt8(p++)
          pts[npt++] = x
          pts[npt++] = y
          pts[npt++] = z
      }
    } //for each streamline
    for (let i = 0; i < npt; i++)
      pts[i] = pts[i]/32.0
    let vox2mmMat = mat4.create()
    mat4.mul(vox2mmMat, zoomMat, trans_to_mni)
    let v = 0
    {
      const pos = vec4.create()
      for (let i = 0; i < npt / 3; i++) {
        vec4.set(pos, pts[v], pts[v + 1], pts[v + 2], 1)
        vec4.transformMat4(pos, pos, vox2mmMat)
        pts[v++] = pos[0]
        pts[v++] = pos[1]
        pts[v++] = pos[2]
      }
    }
    offsetPt0[pos.length] = npt / 3; //solve fence post problem, offset for final streamline
  } // parse_tt()
  parse_tt(mat.track)
  return {
    pts,
    offsetPt0,
  }
} // readTT()

/**
 * Read a TrackVis (.trk) file from an ArrayBuffer.
 *
 * Handles uncompressed, gzip-compressed, and zstd-compressed TRK files.
 * Parses the 1000-byte header (scalars, properties, voxel-to-RAS matrix),
 * reads vertex positions, and applies the voxel-to-RAS transform.
 *
 * @param {ArrayBuffer} buffer - Raw file data (may be gzip/zstd compressed; decompressed automatically).
 * @returns {StreamlineData} An object with `pts`, `offsetPt0`, `dps`, and `dpv`.
 */
function readTRK(buffer) {
  // http://trackvis.org/docs/?subsect=fileformat
  // http://www.tractometer.org/fiberweb/
  // https://github.com/xtk/X/tree/master/io
  // in practice, always little endian
  let reader = new DataView(buffer);
  let magic = reader.getUint32(0, true); //'TRAC'
  if (magic !== 1128354388) {
    //e.g. TRK.gz
    let raw;
    if (magic === 4247762216) { //zstd 
      raw = fzstd.decompress(new Uint8Array(buffer));
      raw = new Uint8Array(raw);
    } else
      raw = fflate.decompressSync(new Uint8Array(buffer));
    buffer = raw.buffer;
    reader = new DataView(buffer);
    magic = reader.getUint32(0, true); //'TRAC'
  }
  let vers = reader.getUint32(992, true); //2
  let hdr_sz = reader.getUint32(996, true); //1000
  if (vers > 2 || hdr_sz !== 1000 || magic !== 1128354388)
    throw new Error("Not a valid TRK file");
  let dps = [];
  let dpv = [];
  let n_scalars = reader.getInt16(36, true);
  if (n_scalars > 0) {
    //data_per_vertex
    for (let i = 0; i < n_scalars; i++) {
      let arr = new Uint8Array(buffer.slice(38 + i * 20, 58 + i * 20));
      let str = new TextDecoder().decode(arr).split("\0").shift();
      dpv.push({
        id: str.trim(),
        vals: [],
      });
    }
  }
  let voxel_sizeX = reader.getFloat32(12, true);
  let voxel_sizeY = reader.getFloat32(16, true);
  let voxel_sizeZ = reader.getFloat32(20, true);
  let zoomMat = mat4.fromValues(
    1 / voxel_sizeX,
    0,
    0,
    -0.5,
    0,
    1 / voxel_sizeY,
    0,
    -0.5,
    0,
    0,
    1 / voxel_sizeZ,
    -0.5,
    0,
    0,
    0,
    1
  );
  let n_properties = reader.getInt16(238, true);
  if (n_properties > 0) {
    for (let i = 0; i < n_properties; i++) {
      let arr = new Uint8Array(buffer.slice(240 + i * 20, 260 + i * 20));
      let str = new TextDecoder().decode(arr).split("\0").shift();
      dps.push({
        id: str.trim(),
        vals: [],
      });
    }
  }
  let mat = mat4.create();
  for (let i = 0; i < 16; i++) mat[i] = reader.getFloat32(440 + i * 4, true);
  if (mat[15] === 0.0) {
    //vox_to_ras[3][3] is 0, it means the matrix is not recorded
    console.log("TRK vox_to_ras not set");
    mat4.identity(mat);
  }
  let vox2mmMat = mat4.create();
  mat4.mul(vox2mmMat, zoomMat, mat);
  let dataView = new DataView(buffer, hdr_sz);
  if ((dataView.byteLength & 3) !== 0) throw new Error("Invalid TRK: track data is not 32-bit aligned");
  let totalWords = dataView.byteLength / 4;

  let num_streamlines = 0;
  let num_points = 0;
  let w = 0;
  while (w < totalWords) {
    const n_pts = dataView.getInt32(w * 4, true);
    if (n_pts < 0) throw new Error("Invalid TRK: negative point count");
    const nextW = w + 1 + n_pts * (3 + n_scalars) + n_properties;
    if (nextW > totalWords) throw new Error("Invalid TRK: truncated track data");
    num_streamlines++;
    num_points += n_pts;
    w = nextW;
  }

  let offsetPt0 = new Uint32Array(num_streamlines + 1);
  let pts = new Float32Array(num_points * 3);
  if (n_scalars > 0) {
    for (let s = 0; s < n_scalars; s++) dpv[s].vals = new Float32Array(num_points);
  }
  if (n_properties > 0) {
    for (let j = 0; j < n_properties; j++) dps[j].vals = new Float32Array(num_streamlines);
  }

  w = 0;
  let npt = 0;
  let noffset = 0;
  let npt3 = 0;

  while (w < totalWords) {
    let n_pts = dataView.getInt32(w * 4, true);
    w = w + 1; // read 1 32-bit integer for number of points in this streamline
    offsetPt0[noffset++] = npt; //index of first vertex in this streamline
    for (let j = 0; j < n_pts; j++) {
      let ptx = dataView.getFloat32(w * 4, true);
      let pty = dataView.getFloat32((w + 1) * 4, true);
      let ptz = dataView.getFloat32((w + 2) * 4, true);
      w += 3; //read 3 32-bit floats for XYZ position
      pts[npt3++] =
        ptx * vox2mmMat[0] +
          pty * vox2mmMat[1] +
          ptz * vox2mmMat[2] +
          vox2mmMat[3];
      pts[npt3++] =
        ptx * vox2mmMat[4] +
          pty * vox2mmMat[5] +
          ptz * vox2mmMat[6] +
          vox2mmMat[7];
      pts[npt3++] =
        ptx * vox2mmMat[8] +
          pty * vox2mmMat[9] +
          ptz * vox2mmMat[10] +
          vox2mmMat[11];
      if (n_scalars > 0) {
        for (let s = 0; s < n_scalars; s++) {
          dpv[s].vals[npt] = dataView.getFloat32(w * 4, true);
          w++;
        }
      }
      npt++;
    } // for j: each point in streamline
    if (n_properties > 0) {
      for (let j = 0; j < n_properties; j++) {
        dps[j].vals[noffset - 1] = dataView.getFloat32(w * 4, true);
        w++;
      }
    }
  } //for each streamline: while w < totalWords
  //add 'first index' as if one more line was added (fence post problem)
  offsetPt0[noffset++] = npt;
  let header = {
    DIMENSIONS: [reader.getInt16(6, true), reader.getInt16(8, true), reader.getInt16(10, true)],
    VOXEL_SIZES: [voxel_sizeX, voxel_sizeY, voxel_sizeZ],
    VOXEL_TO_RASMM: [
      [mat[0], mat[1], mat[2], mat[3]],
      [mat[4], mat[5], mat[6], mat[7]],
      [mat[8], mat[9], mat[10], mat[11]],
      [mat[12], mat[13], mat[14], mat[15]]
    ]
  };

  return {
    pts,
    offsetPt0,
    dps,
    dpv,
    header
  };
} // readTRK()

/**
 * Read an MRtrix (.tck) file from an ArrayBuffer.
 *
 * Parses the text header up to the `END` marker, then reads
 * float32 vertex positions. Streamlines are terminated by NaN
 * (continue) or Infinity (stop) values in the X position.
 *
 * @param {ArrayBuffer} buffer - Raw file data.
 * @returns {StreamlineData} An object with `pts` and `offsetPt0`.
 */
function readTCK(buffer) {
  //https://mrtrix.readthedocs.io/en/latest/getting_started/image_data.html#tracks-file-format-tck
  let len = buffer.byteLength;
  if (len < 20)
    throw new Error("File too small to be TCK: bytes = " + buffer.byteLength);
  let bytes = new Uint8Array(buffer);
  let pos = 0;
  function readStr() {
    while (pos < len && bytes[pos] === 10) pos++; //skip blank lines
    let startPos = pos;
    while (pos < len && bytes[pos] !== 10) pos++;
    pos++; //skip EOLN
    if (pos - startPos < 1) return "";
    return new TextDecoder().decode(buffer.slice(startPos, pos - 1));
  }
  let line = readStr(); //1st line: signature 'mrtrix tracks'
  if (!line.includes("mrtrix tracks")) {
    console.log("Not a valid TCK file");
    return;
  }
  while (pos < len && !line.includes("END")) line = readStr();
  let reader = new DataView(buffer);
  //read and transform vertex positions
  let npt = 0;
  //over-provision offset array to store number of segments
  let offsetPt0 = new Uint32Array(len / 4);
  let noffset = 0;
  //over-provision points array to store vertex positions
  let npt3 = 0;
  let pts = new Float32Array(len / 4);
  offsetPt0[0] = 0; //1st streamline starts at 0
  noffset = 1;
  while (pos + 12 < len) {
    let ptx = reader.getFloat32(pos, true);
    pos += 4;
    let pty = reader.getFloat32(pos, true);
    pos += 4;
    let ptz = reader.getFloat32(pos, true);
    pos += 4;
    if (!isFinite(ptx)) {
      //both NaN and Inifinity are not finite
      offsetPt0[noffset++] = npt;
      if (!isNaN(ptx))
        //terminate if infinity
        break;
    } else {
      pts[npt3++] = ptx;
      pts[npt3++] = pty;
      pts[npt3++] = ptz;
      npt++;
    }
  }
  //resize offset/vertex arrays that were initially over-provisioned
  pts = pts.subarray(0, npt3);
  offsetPt0 = offsetPt0.subarray(0, noffset); 
  return {
    pts,
    offsetPt0,
  };
}; //readTCK()

function readTxtVTK(buffer) {
  var enc = new TextDecoder("utf-8");
  var txt = enc.decode(buffer);
  var lines = txt.split("\n");
  var n = lines.length;
  if (n < 7 || !lines[0].startsWith("# vtk DataFile"))
    throw new Error("Invalid VTK image");
  if (!lines[2].startsWith("ASCII")) throw new Error("Not ASCII VTK mesh");
  let pos = 3;
  while (lines[pos].length < 1) pos++; //skip blank lines
  if (!lines[pos].includes("POLYDATA")) throw new Error("Not ASCII VTK polydata");
  pos++;
  while (lines[pos].length < 1) pos++; //skip blank lines
  if (!lines[pos].startsWith("POINTS")) throw new Error("Not VTK POINTS");
  let items = lines[pos].split(" ");
  let nvert = parseInt(items[1]); //POINTS 10261 float
  let nvert3 = nvert * 3;
  var positions = new Float32Array(nvert * 3);
  let v = 0;
  while (v < nvert * 3) {
    pos++;
    let str = lines[pos].trim();
    let pts = str.split(" ");
    for (let i = 0; i < pts.length; i++) {
      if (v >= nvert3) break;
      positions[v] = parseFloat(pts[i]);
      v++;
    }
  }
  let tris = [];
  pos++;
  while (lines[pos].length < 1) pos++; //skip blank lines
  items = lines[pos].split(" ");
  pos++;
  if (items[0].includes("LINES")) {
    let n_count = parseInt(items[1]);
    if (n_count < 1) throw new Error("Corrupted VTK ASCII");
    let str = lines[pos].trim();
    let offsetPt0 = [];
    let pts = [];
    if (str.startsWith("OFFSETS")) {
      // 'new' line style https://discourse.vtk.org/t/upcoming-changes-to-vtkcellarray/2066
      offsetPt0 = new Uint32Array(n_count);
      pos++;
      let c = 0;
      while (c < n_count) {
        str = lines[pos].trim();
        pos++;
        let items = str.split(" ");
        for (let i = 0; i < items.length; i++) {
          offsetPt0[c] = parseInt(items[i]);
          c++;
          if (c >= n_count) break;
        } //for each line
      } //while offset array not filled
      pts = positions;
    } else {
      //classic line style https://www.visitusers.org/index.php?title=ASCII_VTK_Files
      offsetPt0 = new Uint32Array(n_count + 1);
      let npt = 0;
      pts = [];
      offsetPt0[0] = 0; //1st streamline starts at 0
      let asciiInts = [];
      let asciiIntsPos = 0;
      function lineToInts() {
        //VTK can save one array across multiple ASCII lines
        str = lines[pos].trim();
        let items = str.split(" ");
        asciiInts = [];
        for (let i = 0; i < items.length; i++)
          asciiInts.push(parseInt(items[i]));
        asciiIntsPos = 0;
        pos++;
      }
      lineToInts();
      for (let c = 0; c < n_count; c++) {
        if (asciiIntsPos >= asciiInts.length) lineToInts();
        let numPoints = asciiInts[asciiIntsPos++];
        npt += numPoints;
        offsetPt0[c + 1] = npt;
        for (let i = 0; i < numPoints; i++) {
          if (asciiIntsPos >= asciiInts.length) lineToInts();
          let idx = asciiInts[asciiIntsPos++] * 3;
          pts.push(positions[idx + 0]); //X
          pts.push(positions[idx + 1]); //Y
          pts.push(positions[idx + 2]); //Z
        } //for numPoints: number of segments in streamline
      } //for n_count: number of streamlines
    }
    return {
      pts,
      offsetPt0,
    };
  } else if (items[0].includes("TRIANGLE_STRIPS")) {
    let nstrip = parseInt(items[1]);
    for (let i = 0; i < nstrip; i++) {
      let str = lines[pos].trim();
      pos++;
      let vs = str.split(" ");
      let ntri = parseInt(vs[0]) - 2; //-2 as triangle strip is creates pts - 2 faces
      let k = 1;
      for (let t = 0; t < ntri; t++) {
        if (t % 2) {
          // preserve winding order
          tris.push(parseInt(vs[k + 2]));
          tris.push(parseInt(vs[k + 1]));
          tris.push(parseInt(vs[k]));
        } else {
          tris.push(parseInt(vs[k]));
          tris.push(parseInt(vs[k + 1]));
          tris.push(parseInt(vs[k + 2]));
        }
        k += 1;
      } //for each triangle
    } //for each strip
  } else if (items[0].includes("POLYGONS")) {
    let npoly = parseInt(items[1]);
    for (let i = 0; i < npoly; i++) {
      let str = lines[pos].trim();
      pos++;
      let vs = str.split(" ");
      let ntri = parseInt(vs[0]) - 2; //e.g. 3 for triangle
      let fx = parseInt(vs[1]);
      let fy = parseInt(vs[2]);
      for (let t = 0; t < ntri; t++) {
        let fz = parseInt(vs[3 + t]);
        tris.push(fx);
        tris.push(fy);
        tris.push(fz);
        fy = fz;
      }
    }
  } else throw new Error("Unsupported ASCII VTK datatype " + items[0]);
  var indices = new Int32Array(tris);
  return {
    positions,
    indices,
  };
} // readTxtVTK()

/**
 * Read a VTK legacy (.vtk) file from an ArrayBuffer.
 *
 * Supports both ASCII and binary formats. Handles POLYDATA with
 * LINES (classic and DiPy OFFSETS-style), TRIANGLE_STRIPS, and
 * POLYGONS. Binary VTK files are expected in big-endian byte order.
 *
 * @param {ArrayBuffer} buffer - Raw file data.
 * @returns {StreamlineData|{positions: Float32Array, indices: Int32Array}}
 *   For streamline data (LINES) returns `{pts, offsetPt0}`.
 *   For mesh data (TRIANGLE_STRIPS, POLYGONS) returns `{positions, indices}`.
 */
function readVTK (buffer) {
  let len = buffer.byteLength;
  if (len < 20)
    throw new Error("File too small to be VTK: bytes = " + buffer.byteLength);
  var bytes = new Uint8Array(buffer);
  let pos = 0;
  function readStr() {
    while (pos < len && bytes[pos] === 10) pos++; //skip blank lines
    let startPos = pos;
    while (pos < len && bytes[pos] !== 10) pos++;
    pos++; //skip EOLN
    if (pos - startPos < 1) return "";
    return new TextDecoder().decode(buffer.slice(startPos, pos - 1));
  }
  let line = readStr(); //1st line: signature
  if (!line.startsWith("# vtk DataFile")) throw new Error("Invalid VTK mesh");
  line = readStr(); //2nd line comment
  line = readStr(); //3rd line ASCII/BINARY
  if (line.startsWith("ASCII")) return readTxtVTK(buffer); //from NiiVue
  else if (!line.startsWith("BINARY"))
    throw new Error("Invalid VTK image, expected ASCII or BINARY: " + line);
  line = readStr(); //5th line "DATASET POLYDATA"
  if (!line.includes("POLYDATA")) throw new Error("Only able to read VTK POLYDATA: " + line);
  line = readStr(); //6th line "POINTS 10261 float"
  if (
    !line.includes("POINTS") ||
    (!line.includes("double") && !line.includes("float"))
  )
    console.log("Only able to read VTK float or double POINTS" + line);
  let isFloat64 = line.includes("double");
  let items = line.split(" ");
  let nvert = parseInt(items[1]); //POINTS 10261 float
  let nvert3 = nvert * 3;
  var positions = new Float32Array(nvert3);
  var reader = new DataView(buffer);
  if (isFloat64) {
    for (let i = 0; i < nvert3; i++) {
      positions[i] = reader.getFloat64(pos, false);
      pos += 8;
    }
  } else {
    for (let i = 0; i < nvert3; i++) {
      positions[i] = reader.getFloat32(pos, false);
      pos += 4;
    }
  }
  line = readStr(); //Type, "LINES 11885 "
  items = line.split(" ");
  let tris = [];
  if (items[0].includes("LINES")) {
    let n_count = parseInt(items[1]);
    //tractography data: detect if borked by DiPy
    let posOK = pos;
    line = readStr(); //borked files "OFFSETS vtktypeint64"
    if (line.startsWith("OFFSETS")) {
      let offset_items = line.trim().split(/\s+/);
      let num_offsets = parseInt(offset_items[2]);
      let isInt64 = false;
      if (line.includes("int64")) isInt64 = true;

      let offsetPt0 = new Uint32Array(num_offsets);
      if (isInt64) {
        let isOverflowInt32 = false;
        for (let c = 0; c < num_offsets; c++) {
          let idx = reader.getInt32(pos, false);
          if (idx !== 0) isOverflowInt32 = true;
          pos += 4;
          idx = reader.getInt32(pos, false);
          pos += 4;
          offsetPt0[c] = idx;
        }
        if (isOverflowInt32)
          console.log("int32 overflow: JavaScript does not support int64");
      } else {
        for (let c = 0; c < num_offsets; c++) {
          let idx = reader.getInt32(pos, false);
          pos += 4;
          offsetPt0[c] = idx;
        }
      }
      let pts = positions;
      return {
        pts,
        offsetPt0,
      };
    }
    pos = posOK; //valid VTK file
    let npt = 0;
    let offsetPt0 = [];
    let pts = [];
    offsetPt0.push(npt); //1st streamline starts at 0
    for (let c = 0; c < n_count; c++) {
      let numPoints = reader.getInt32(pos, false);
      pos += 4;
      npt += numPoints;
      offsetPt0.push(npt);
      for (let i = 0; i < numPoints; i++) {
        let idx = reader.getInt32(pos, false) * 3;
        pos += 4;
        pts.push(positions[idx + 0]);
        pts.push(positions[idx + 1]);
        pts.push(positions[idx + 2]);
      } //for numPoints: number of segments in streamline
    } //for n_count: number of streamlines
    return {
      pts,
      offsetPt0,
    };
  } else if (items[0].includes("TRIANGLE_STRIPS")) {
    let nstrip = parseInt(items[1]);
    for (let i = 0; i < nstrip; i++) {
      let ntri = reader.getInt32(pos, false) - 2; //-2 as triangle strip is creates pts - 2 faces
      pos += 4;
      for (let t = 0; t < ntri; t++) {
        if (t % 2) {
          // preserve winding order
          tris.push(reader.getInt32(pos + 8, false));
          tris.push(reader.getInt32(pos + 4, false));
          tris.push(reader.getInt32(pos, false));
        } else {
          tris.push(reader.getInt32(pos, false));
          tris.push(reader.getInt32(pos + 4, false));
          tris.push(reader.getInt32(pos + 8, false));
        }
        pos += 4;
      } //for each triangle
      pos += 8;
    } //for each strip
  } else if (items[0].includes("POLYGONS")) {
    let npoly = parseInt(items[1]);
    for (let i = 0; i < npoly; i++) {
      let ntri = reader.getInt32(pos, false) - 2; //3 for single triangle, 4 for 2 triangles
      pos += 4;
      let fx = reader.getInt32(pos, false);
      pos += 4;
      let fy = reader.getInt32(pos, false);
      pos += 4;
      for (let t = 0; t < ntri; t++) {
        let fz = reader.getInt32(pos, false);
        pos += 4;
        tris.push(fx);
        tris.push(fy);
        tris.push(fz);
        fy = fz;
      } //for each triangle
    } //for each polygon
  } else throw new Error("Unsupported ASCII VTK datatype " + items[0]);
  var indices = new Int32Array(tris);
  return {
    positions,
    indices,
  };
}; // readVTK()

function getZip64OriginalSizes(zipData) {
  // Parse the ZIP central directory to get correct uncompressed sizes.
  // fflate ZIP64 bug: file.originalSize in the filter callback returns 0xFFFFFFFF
  // (the 32-bit sentinel) instead of reading the real size from the ZIP64
  // extended information extra field (tag 0x0001) in the central directory.
  //
  // Supports ZIP32 (entries < 4 GB, CD < 4 GB) and ZIP64 (entries or CD
  // offset up to 2^53 bytes, the JavaScript safe-integer limit).
  let u8;
  if (zipData instanceof ArrayBuffer) {
    u8 = new Uint8Array(zipData);
  } else {
    u8 = new Uint8Array(zipData.buffer, zipData.byteOffset, zipData.byteLength);
  }
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const n = u8.byteLength;
  const sizes = {};

  // Read a 64-bit little-endian uint as a JS number (safe up to 2^53)
  function getUint64(offset) {
    const lo = dv.getUint32(offset,     true);
    const hi = dv.getUint32(offset + 4, true);
    return hi * 0x100000000 + lo;
  }

  // Find End of Central Directory record (PK\x05\x06) scanning backwards.
  // Stop 22 bytes from end (minimum EOCD size); allow up to 64 KB ZIP comment.
  let eocd = -1;
  for (let i = n - 22; i >= Math.max(0, n - 65558); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) return sizes;

  let cdCount  = dv.getUint16(eocd + 8,  true);
  let cdOffset = dv.getUint32(eocd + 16, true);

  // Check for ZIP64 EOCD locator (PK\x06\x07), which must sit exactly 20
  // bytes before the EOCD when no ZIP comment is present, but the ZIP spec
  // only guarantees it precedes the EOCD — scan the last 64 KB for it.
  for (let i = eocd - 20; i >= Math.max(0, eocd - 65558); i--) {
    if (dv.getUint32(i, true) === 0x07064b50) {          // PK\x06\x07
      const eocd64off = getUint64(i + 8);                // offset of ZIP64 EOCD
      if (eocd64off + 56 <= n && dv.getUint32(eocd64off, true) === 0x06064b50) {
        cdCount  = getUint64(eocd64off + 32);            // 8-byte total entry count
        cdOffset = getUint64(eocd64off + 48);            // 8-byte CD start offset
      }
      break;
    }
  }

  // Parse central directory records
  let pos = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (pos + 46 > n || dv.getUint32(pos, true) !== 0x02014b50) break; // PK\x01\x02
    let origSize = dv.getUint32(pos + 24, true);
    const fnLen  = dv.getUint16(pos + 28, true);
    const exLen  = dv.getUint16(pos + 30, true);
    const cmLen  = dv.getUint16(pos + 32, true);
    const fname  = new TextDecoder().decode(u8.subarray(pos + 46, pos + 46 + fnLen));
    // If 0xFFFFFFFF, read real size from ZIP64 extended info extra field (tag 0x0001).
    // The ZIP64 extra field encodes: origSize (8), compSize (8), localOffset (8),
    // diskStart (4) — but only the fields that were 0xFFFFFFFF in the CD are present.
    if (origSize === 0xFFFFFFFF) {
      let ep = pos + 46 + fnLen;
      const epEnd = ep + exLen;
      while (ep + 4 <= epEnd) {
        const tag = dv.getUint16(ep,     true);
        const sz  = dv.getUint16(ep + 2, true);
        if (tag === 0x0001 && sz >= 8) {
          origSize = getUint64(ep + 4);  // first 8-byte field is original size
          break;
        }
        ep += 4 + sz;
      }
    }
    sizes[fname] = origSize;
    pos += 46 + fnLen + exLen + cmLen;
  }
  return sizes;
} // getZip64OriginalSizes()

/**
 * Read a TRX (.trx) file — the modern tractography format.
 *
 * This is an **async** function. It fetches the TRX zip container,
 * decompresses it, reads `header.json`, and parses positions, offsets,
 * and per-group/per-streamline/per-vertex data arrays.
 *
 * Supports all numeric types including float16 (automatically converted
 * to float32) and uint64/int64 (lower 32 bits only; warns on overflow).
 *
 * @param {string} url - URL or local file path (behavior controlled by `urlIsLocalFile`).
 * @param {boolean} [urlIsLocalFile=false] - If `true`, reads from local filesystem via `fs.readFileSync`.
 * @returns {Promise<StreamlineData>} A promise resolving to an object with `pts`, `offsetPt0`,
 *   `dpg`, `dps`, `dpv`, and `header`.
 */
async function readTRX(url, urlIsLocalFile = false) {
  //Javascript does not support float16, so we convert to float32
  //https://stackoverflow.com/questions/5678432/decompressing-half-precision-floats-in-javascript
//intrinsics https://stackoverflow.com/questions/5515333/how-can-i-optimize-conversion-from-half-precision-float16-to-single-precision-fl
// x86-64: _mm_cvtps_ph/_mm256_cvtps_ph _mm_cvtph_ps/_mm256_cvtph_ps  AR: vcvt
  function decodeFloat16(binary) {
    "use strict";
    var exponent = (binary & 0x7c00) >> 10,
      fraction = binary & 0x03ff;
    return (
      (binary >> 15 ? -1 : 1) *
      (exponent
        ? exponent === 0x1f
          ? fraction
            ? NaN
            : Infinity
          : Math.pow(2, exponent - 15) * (1 + fraction / 0x400)
        : 6.103515625e-5 * (fraction / 0x400))
    );
  } // decodeFloat16()
  let noff = 0;
  let npt = 0;
  let pts = [];
  let offsetPt0 = [];
  let dpv = [];
  let dps = [];
  let dpg = [];
  let groups = [];
  let header = [];
  let isOverflowUint64 = false;
  let positions_dtype = "float32";
  let data = [];
  function getAlignedArray(constructor, dataArray) {
    const bytes = constructor.BYTES_PER_ELEMENT;
    if (dataArray.byteOffset % bytes === 0) {
      return new constructor(dataArray.buffer, dataArray.byteOffset, dataArray.byteLength / bytes);
    } else {
      return new constructor(dataArray.slice().buffer);
    }
  }
  if (urlIsLocalFile) {
    const stats = fs.statSync(url);
    if (stats.size >= 2 * 1024 * 1024 * 1024) {
      const size = stats.size;
      const arrayBuffer = new ArrayBuffer(size);
      const uint8Array = new Uint8Array(arrayBuffer);
      const fd = fs.openSync(url, 'r');
      try {
        const chunkSize = 512 * 1024 * 1024;
        let offset = 0;
        while (offset < size) {
          const bytesToRead = Math.min(chunkSize, size - offset);
          const bytesRead = fs.readSync(fd, uint8Array, offset, bytesToRead, offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
      } finally {
        fs.closeSync(fd);
      }
      data = Buffer.from(arrayBuffer);
    } else {
      data = fs.readFileSync(url);
    }
  } else {
    let response = await fetch(url);
    if (!response.ok) throw Error(response.statusText);
    data = await response.arrayBuffer();
  }
  // Parse the ZIP central directory ourselves: fflate's file.originalSize
  // returns 0xFFFFFFFF for ZIP64 entries instead of reading the ZIP64 extra field.
  const filesInfo = parseZipCentralDirectory(urlIsLocalFile ? url : data, urlIsLocalFile);

  let fd = null;
  if (urlIsLocalFile) {
    fd = fs.openSync(url, 'r');
  }

  function readEntryData(fileInfo) {
      if (fileInfo.compMethod === 0) {
          const buffer = new ArrayBuffer(fileInfo.origSize);
          const u8 = new Uint8Array(buffer);
          if (urlIsLocalFile) {
              const chunkSize = 512 * 1024 * 1024;
              let bytesRead = 0;
              while (bytesRead < fileInfo.origSize) {
                  let readSize = Math.min(chunkSize, fileInfo.origSize - bytesRead);
                  fs.readSync(fd, u8, bytesRead, readSize, fileInfo.dataOffset + bytesRead);
                  bytesRead += readSize;
              }
          } else {
              const src = new Uint8Array(data, fileInfo.dataOffset, fileInfo.origSize);
              u8.set(src);
          }
          return u8;
      } else if (fileInfo.compMethod === 8) {
          const compSize = fileInfo.compSize || fileInfo.origSize;
          const compressed = new Uint8Array(compSize);
          if (urlIsLocalFile) {
              fs.readSync(fd, compressed, 0, compSize, fileInfo.dataOffset);
          } else {
              const src = new Uint8Array(data, fileInfo.dataOffset, compSize);
              compressed.set(src);
          }
          return fflate.inflateSync(compressed);
      } else {
          throw new Error("Unsupported compression method: " + fileInfo.compMethod);
      }
  }

  var keys = Object.keys(filesInfo);
  for (var i = 0, len = keys.length; i < len; i++) {
    const key = keys[i];
    let parts = key.split("/");
    let fname = parts.slice(-1)[0];
    if (fname.startsWith(".")) continue;
    let pname = parts.slice(-2)[0];
    let tag = fname.split(".")[0];

    const fileInfo = filesInfo[key];
    if (fileInfo.origSize === 0) continue;

    if (fname.includes("header.json")) {
      const entryData = readEntryData(fileInfo);
      let jsonString = new TextDecoder().decode(entryData);
      if (jsonString.charCodeAt(0) === 0xFEFF) jsonString = jsonString.slice(1);
      header = JSON.parse(jsonString.trim());
      continue;
    }

    const entryData = readEntryData(fileInfo);

    let nval = 0;
    let vals = [];
    let data = entryData;
    if (fname.endsWith(".uint64") || fname.endsWith(".int64")) {
      nval = data.length / 8; //8 bytes per 64bit input
      vals = new Uint32Array(nval);
      const u32 = getAlignedArray(Uint32Array, data);
      let j = 0;
      for (let i = 0; i < nval; i++) {
        vals[i] = u32[j];
        if (u32[j + 1] !== 0) isOverflowUint64 = true;
        j += 2;
      }
    } else if (fname.endsWith(".uint32")) {
      vals = getAlignedArray(Uint32Array, data);
    } else if (fname.endsWith(".uint16")) {
      vals = getAlignedArray(Uint16Array, data);
    } else if (fname.endsWith(".uint8")) {
      vals = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else if (fname.endsWith(".int32")) {
      vals = getAlignedArray(Int32Array, data);
    } else if (fname.endsWith(".int16")) {
      vals = getAlignedArray(Int16Array, data);
    } else if (fname.endsWith(".int8")) {
      vals = new Int8Array(data.buffer, data.byteOffset, data.byteLength);
    } else if (fname.endsWith(".float64")) {
      vals = getAlignedArray(Float64Array, data);
    } else if (fname.endsWith(".float32")) {
      vals = getAlignedArray(Float32Array, data);
    } else if (fname.endsWith(".float16")) {
      nval = data.length / 2; //2 bytes per 16bit input
      vals = new Float32Array(nval);
      const u16 = getAlignedArray(Uint16Array, data);
      const lut = new Float32Array(65536)
      for (let i = 0; i < 65536; i++) lut[i] = decodeFloat16(i)
      for (let i = 0; i < nval; i++) vals[i] = lut[u16[i]]
    } else continue; //not a data array
    nval = vals.length;
    //next: read data_per_group
    const dpgIndex = parts.indexOf("dpg");
    if (dpgIndex !== -1 && parts.length >= dpgIndex + 3) {
      const groupId = parts[dpgIndex + 1];
      dpg.push({
        id: groupId + "/" + tag, // e.g. "AF_R/volume"
        fname: parts.slice(dpgIndex + 1).join("/"), // e.g. "AF_R/volume.uint32"
        vals: vals,
      });
      continue;
    }
    //next: read groups
    if (pname === "groups") {
      groups.push({
        id: tag,
        fname: fname,
        vals: vals,
      });
      continue;
    }
    //next: read data_per_vertex
    if (pname.includes("dpv")) {
      dpv.push({
        id: tag,
        fname: fname,
        vals: vals,
      });
      continue;
    }
    //next: read data_per_streamline
    if (pname.includes("dps")) {
      dps.push({
        id: tag,
        fname: fname,
        vals: vals,
      });
      continue;
    }
    //Next: read offsets: Always uint64
    if (fname.startsWith("offsets.")) {
      //javascript does not have 64-bit integers! read lower 32-bits
      noff = nval; //8 bytes per 64bit input
      //we need to solve the fence post problem, so we can not use slice
      offsetPt0 = new Uint32Array(nval + 1);
      for (let i = 0; i < nval; i++) offsetPt0[i] = vals[i];
    }
    if (fname.startsWith("positions.3.")) {
      npt = nval; //4 bytes per 32bit input
      pts = vals;
      if (fname.endsWith(".float64")) positions_dtype = "float64";
      else if (fname.endsWith(".float16")) positions_dtype = "float16";
      else positions_dtype = "float32";
    }
  }
  if (isOverflowUint64)
    throw new Error("Too many vertices: JavaScript does not support 64 bit integers");

  if (offsetPt0[noff - 1] === npt / 3) {
    offsetPt0 = offsetPt0.subarray(0, noff);
  } else {
    offsetPt0[noff] = npt / 3; //solve fence post problem, offset for final streamline
  }

  return {
    pts,
    offsetPt0,
    dps,
    dpv,
    dpg,
    groups,
    header,
    positions_dtype,
  };
}; // readTRX()
// Fast float32 to float16 conversion
const _f16_floatView = new Float32Array(1);
const _f16_int32View = new Int32Array(_f16_floatView.buffer);

function encodeFloat16(val) {
    _f16_floatView[0] = val;
    const f = _f16_int32View[0];
    
    const sign = (f >> 16) & 0x8000;
    let exponent = ((f >> 23) & 0xff) - 127;
    let mantissa = f & 0x007fffff;
    
    if (exponent <= -15) {
        if (exponent < -24) {
            return sign; // underflow
        }
        mantissa = (mantissa | 0x00800000) >> (-14 - exponent);
        return sign | (mantissa >> 13);
    } else if (exponent >= 16) {
        return sign | 0x7c00; // overflow to infinity
    }
    
    return sign | ((exponent + 15) << 10) | (mantissa >> 13);
}

function float32ToFloat16(float32Array) {
    const out = new Uint16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
        out[i] = encodeFloat16(float32Array[i]);
    }
    return out;
}

function buildTckHeader(numStreamlines) {
    let offset = 80;
    while (true) {
        let h = `mrtrix tracks\ncount: ${String(numStreamlines).padStart(10, '0')}\ndatatype: Float32LE\nfile: . ${offset}\nEND\n`;
        if (h.length <= offset) {
            return h.padEnd(offset, ' ');
        }
        offset = h.length;
    }
}

function saveTCK(filepath, obj) {
    const fd = fs.openSync(filepath, 'w');
    const numStreamlines = obj.offsetPt0.length - 1;
    const header = buildTckHeader(numStreamlines);
    fs.writeSync(fd, header);

    const chunkSize = 16 * 1024 * 1024; // 16MB buffer
    const buf = new ArrayBuffer(chunkSize);
    const view = new DataView(buf);
    const u8View = new Uint8Array(buf);

    let bufOffset = 0;
    const pts = obj.pts;
    const offsets = obj.offsetPt0;

    for (let i = 0; i < numStreamlines; i++) {
        const start = offsets[i];
        const end = offsets[i+1];
        
        for (let j = start; j < end; j++) {
            if (bufOffset + 12 > chunkSize) {
                fs.writeSync(fd, u8View, 0, bufOffset);
                bufOffset = 0;
            }
            view.setFloat32(bufOffset, pts[j*3], true);
            view.setFloat32(bufOffset + 4, pts[j*3 + 1], true);
            view.setFloat32(bufOffset + 8, pts[j*3 + 2], true);
            bufOffset += 12;
        }
        if (bufOffset + 12 > chunkSize) {
            fs.writeSync(fd, u8View, 0, bufOffset);
            bufOffset = 0;
        }
        view.setFloat32(bufOffset, NaN, true);
        view.setFloat32(bufOffset + 4, NaN, true);
        view.setFloat32(bufOffset + 8, NaN, true);
        bufOffset += 12;
    }

    if (bufOffset + 12 > chunkSize) {
        fs.writeSync(fd, u8View, 0, bufOffset);
        bufOffset = 0;
    }
    view.setFloat32(bufOffset, Infinity, true);
    view.setFloat32(bufOffset + 4, Infinity, true);
    view.setFloat32(bufOffset + 8, Infinity, true);
    bufOffset += 12;

    if (bufOffset > 0) {
        fs.writeSync(fd, u8View, 0, bufOffset);
    }
    fs.closeSync(fd);
}

function saveTRK(filepath, obj, originalFilename, refHeader = null) {
    const fd = fs.openSync(filepath, 'w');
    const headerBytes = new Uint8Array(1000);
    const view = new DataView(headerBytes.buffer);

    headerBytes.set([84, 82, 65, 67, 75], 0); // 'TRACK'
    // voxel_order written after resolvedHeader is loaded (see below)

    let dim = [256, 256, 256];
    let voxelSize = [1, 1, 1];
    let voxToRas = [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1]
    ];

    const resolvedHeader = (obj.header && obj.header.VOXEL_TO_RASMM) ? obj.header : refHeader;
    if (!resolvedHeader) throw new Error("TCK/VTK → TRK requires a reference NIfTI header (pass refHeader)");

    dim = resolvedHeader.DIMENSIONS;
    voxToRas = resolvedHeader.VOXEL_TO_RASMM;
    voxelSize = [
        Math.sqrt(voxToRas[0][0]**2 + voxToRas[1][0]**2 + voxToRas[2][0]**2),
        Math.sqrt(voxToRas[0][1]**2 + voxToRas[1][1]**2 + voxToRas[2][1]**2),
        Math.sqrt(voxToRas[0][2]**2 + voxToRas[1][2]**2 + voxToRas[2][2]**2)
    ];

    // Derive voxel_order from the affine (mirrors nibabel.aff2axcodes / io_orientation)
    const _order = axcodesFromAffine(voxToRas);
    headerBytes.set([_order.charCodeAt(0), _order.charCodeAt(1), _order.charCodeAt(2), 0], 948);

    view.setInt16(6, dim[0], true);
    view.setInt16(8, dim[1], true);
    view.setInt16(10, dim[2], true);

    view.setFloat32(12, voxelSize[0], true);
    view.setFloat32(16, voxelSize[1], true);
    view.setFloat32(20, voxelSize[2], true);

    let off = 440;
    for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
            view.setFloat32(off, voxToRas[r][c], true);
            off += 4;
        }
    }
    // Removed hardcoded RAS voxel order to prevent coordinate flipping by Nibabel
    // Reconstruct the exact readTRK scaling matrix
    let zoomMat = mat4.fromValues(
        1 / voxelSize[0], 0, 0, -0.5,
        0, 1 / voxelSize[1], 0, -0.5,
        0, 0, 1 / voxelSize[2], -0.5,
        0, 0, 0, 1
    );

    // Map TRK header to a row-major array matching readTRK behavior
    let mat = mat4.create();
    mat[0] = voxToRas[0][0]; mat[1] = voxToRas[0][1]; mat[2] = voxToRas[0][2]; mat[3] = voxToRas[0][3];
    mat[4] = voxToRas[1][0]; mat[5] = voxToRas[1][1]; mat[6] = voxToRas[1][2]; mat[7] = voxToRas[1][3];
    mat[8] = voxToRas[2][0]; mat[9] = voxToRas[2][1]; mat[10] = voxToRas[2][2]; mat[11] = voxToRas[2][3];
    mat[12] = voxToRas[3][0]; mat[13] = voxToRas[3][1]; mat[14] = voxToRas[3][2]; mat[15] = voxToRas[3][3];

    let vox2mmMat = mat4.create();
    mat4.mul(vox2mmMat, zoomMat, mat);

    // Transpose to column-major for gl-matrix inversion
    let colMajorVox2mm = mat4.create();
    mat4.transpose(colMajorVox2mm, vox2mmMat);

    let colMajorMm2trk = mat4.create();
    mat4.invert(colMajorMm2trk, colMajorVox2mm);

    // Transpose back to row-major for straightforward vector application
    let mm2trkMat = mat4.create();
    mat4.transpose(mm2trkMat, colMajorMm2trk);

    const numStreamlines = obj.offsetPt0.length - 1;
    view.setInt32(988, numStreamlines, true);
    view.setInt32(992, 2, true);
    view.setInt32(996, 1000, true);

    fs.writeSync(fd, headerBytes);

    const chunkSize = 16 * 1024;
    const buf = new ArrayBuffer(chunkSize);
    const payloadView = new DataView(buf);
    const u8View = new Uint8Array(buf);

    let bufOffset = 0;
    const pts = obj.pts;
    const offsets = obj.offsetPt0;

    for (let i = 0; i < numStreamlines; i++) {
        const start = offsets[i];
        const end = offsets[i+1];
        const n_pts = end - start;

        if (bufOffset + 4 > chunkSize) {
            fs.writeSync(fd, u8View, 0, bufOffset);
            bufOffset = 0;
        }
        payloadView.setInt32(bufOffset, n_pts, true);
        bufOffset += 4;

        for (let j = start; j < end; j++) {
            if (bufOffset + 12 > chunkSize) {
                fs.writeSync(fd, u8View, 0, bufOffset);
                bufOffset = 0;
            }
            
            let x = pts[j*3];
            let y = pts[j*3 + 1];
            let z = pts[j*3 + 2];

            let vx = x * mm2trkMat[0] + y * mm2trkMat[1] + z * mm2trkMat[2] + mm2trkMat[3];
            let vy = x * mm2trkMat[4] + y * mm2trkMat[5] + z * mm2trkMat[6] + mm2trkMat[7];
            let vz = x * mm2trkMat[8] + y * mm2trkMat[9] + z * mm2trkMat[10] + mm2trkMat[11];

            payloadView.setFloat32(bufOffset, vx, true);
            payloadView.setFloat32(bufOffset + 4, vy, true);
            payloadView.setFloat32(bufOffset + 8, vz, true);
            bufOffset += 12;
        }
    }

    if (bufOffset > 0) {
        fs.writeSync(fd, u8View, 0, bufOffset);
    }
    fs.closeSync(fd);
}

function saveVTK(filepath, obj) {
    const fd = fs.openSync(filepath, 'w');
    const numStreamlines = obj.offsetPt0.length - 1;
    const numPoints = obj.pts.length / 3;

    const header = `# vtk DataFile Version 3.0\nvtk output\nBINARY\nDATASET POLYDATA\nPOINTS ${numPoints} float\n`;
    fs.writeSync(fd, header);

    const pts = obj.pts;
    const offsets = obj.offsetPt0;

    const chunkSize = 16 * 1024 * 1024;
    const buf = new ArrayBuffer(chunkSize);
    const view = new DataView(buf);
    const u8View = new Uint8Array(buf);

    let bufOffset = 0;
    for (let i = 0; i < numPoints; i++) {
        if (bufOffset + 12 > chunkSize) {
            fs.writeSync(fd, u8View, 0, bufOffset);
            bufOffset = 0;
        }
        view.setFloat32(bufOffset, pts[i*3], false); // Big endian
        view.setFloat32(bufOffset + 4, pts[i*3 + 1], false);
        view.setFloat32(bufOffset + 8, pts[i*3 + 2], false);
        bufOffset += 12;
    }
    if (bufOffset > 0) {
        fs.writeSync(fd, u8View, 0, bufOffset);
        bufOffset = 0;
    }

    const cellArraySize = numStreamlines + numPoints;
    const linesHeader = `LINES ${numStreamlines} ${cellArraySize}\n`;
    fs.writeSync(fd, linesHeader);

    for (let i = 0; i < numStreamlines; i++) {
        const start = offsets[i];
        const end = offsets[i+1];
        const n_pts = end - start;

        if (bufOffset + 4 > chunkSize) {
            fs.writeSync(fd, u8View, 0, bufOffset);
            bufOffset = 0;
        }
        view.setInt32(bufOffset, n_pts, false); // Big endian
        bufOffset += 4;

        for (let j = start; j < end; j++) {
            if (bufOffset + 4 > chunkSize) {
                fs.writeSync(fd, u8View, 0, bufOffset);
                bufOffset = 0;
            }
            view.setInt32(bufOffset, j, false);
            bufOffset += 4;
        }
    }
    if (bufOffset > 0) {
        fs.writeSync(fd, u8View, 0, bufOffset);
    }
    fs.closeSync(fd);
}

async function saveTRX(filepath, obj, originalFilename, refHeader = null) {
    let dtype = obj.positions_dtype || "float32";
    let ptsData = obj.pts;
    if (ptsData instanceof Float64Array) {
        dtype = "float64";
    }

    if ((originalFilename && originalFilename.includes("f16")) || dtype === "float16") {
        dtype = "float16";
        ptsData = float32ToFloat16(obj.pts);
    } else if (originalFilename && originalFilename.includes("f64")) {
        dtype = "float64";
        ptsData = new Float64Array(obj.pts);
    }

    const numStreamlines = obj.offsetPt0.length - 1;
    const numPoints = obj.pts.length / 3;

    let header = {
        "VOXEL_TO_RASMM": [
            [1, 0, 0, 0],
            [0, 1, 0, 0],
            [0, 0, 1, 0],
            [0, 0, 0, 1]
        ],
        "DIMENSIONS": [256, 256, 256],
        "NB_STREAMLINES": numStreamlines,
        "NB_VERTICES": numPoints
    };

    const resolvedHeader = (obj.header && obj.header.VOXEL_TO_RASMM) ? obj.header : refHeader;
    if (!resolvedHeader) throw new Error("TCK/VTK → TRX requires a reference NIfTI header (pass refHeader)");
    header.VOXEL_TO_RASMM = resolvedHeader.VOXEL_TO_RASMM;
    header.DIMENSIONS = resolvedHeader.DIMENSIONS;

    const zipObj = {};
    zipObj["header.json"] = fflate.strToU8(JSON.stringify(header, null, 4));
    zipObj[`positions.3.${dtype}`] = new Uint8Array(ptsData.buffer, ptsData.byteOffset, ptsData.byteLength);
    
    let offsetDtype = "uint32";
    let offsetData = obj.offsetPt0.subarray ? obj.offsetPt0.subarray(0, numStreamlines + 1) : obj.offsetPt0.slice(0, numStreamlines + 1);
    if (originalFilename && originalFilename.includes("ui64")) {
        offsetDtype = "uint64";
        const u64Bytes = new Uint8Array((numStreamlines + 1) * 8);
        const view = new DataView(u64Bytes.buffer);
        for (let i = 0; i <= numStreamlines; i++) {
            view.setUint32(i * 8, offsetData[i], true);
            view.setUint32(i * 8 + 4, 0, true);
        }
        zipObj[`offsets.${offsetDtype}`] = u64Bytes;
    } else {
        zipObj[`offsets.${offsetDtype}`] = new Uint8Array(offsetData.buffer, offsetData.byteOffset, offsetData.byteLength);
    }
    
    function getDtypeExt(vals) {
        if (vals instanceof Float64Array) return 'float64';
        if (vals instanceof Float32Array) return 'float32';
        if (vals instanceof Uint32Array) return 'uint32';
        if (vals instanceof Int32Array) return 'int32';
        if (vals instanceof Uint16Array) return 'uint16';
        if (vals instanceof Int16Array) return 'int16';
        if (vals instanceof Uint8Array) return 'uint8';
        if (vals instanceof Int8Array) return 'int8';
        return 'float32';
    }

    function getCorrectFname(prop) {
        let name = prop.fname || prop.id;
        let parts = name.split('.');
        let ext = getDtypeExt(prop.vals);
        if (parts.length >= 2) {
            parts[parts.length - 1] = ext;
            return parts.join('.');
        }
        return name + '.' + ext;
    }

    if (obj.dpv) {
        for (let prop of obj.dpv) {
            zipObj[`dpv/${getCorrectFname(prop)}`] = new Uint8Array(prop.vals.buffer, prop.vals.byteOffset, prop.vals.byteLength);
        }
    }
    if (obj.dps) {
        for (let prop of obj.dps) {
            zipObj[`dps/${getCorrectFname(prop)}`] = new Uint8Array(prop.vals.buffer, prop.vals.byteOffset, prop.vals.byteLength);
        }
    }
    if (obj.dpg) {
        for (let prop of obj.dpg) {
            zipObj[`dpg/${getCorrectFname(prop)}`] = new Uint8Array(prop.vals.buffer, prop.vals.byteOffset, prop.vals.byteLength);
        }
    }
    if (obj.groups) {
        for (let prop of obj.groups) {
            zipObj[`groups/${getCorrectFname(prop)}`] = new Uint8Array(prop.vals.buffer, prop.vals.byteOffset, prop.vals.byteLength);
        }
    }
    // Optionally save extra header files
    if (obj.header && obj.header.extraFiles) {
        for (const [fname, content] of Object.entries(obj.header.extraFiles)) {
            zipObj[fname] = content;
        }
    }

    if (typeof window === "undefined") {
        // NodeJS
        return await writeZip64Stream(filepath, zipObj);
    } else {
        // Browser
        const zipped = fflate.zipSync(zipObj, { level: 0 });
        const blob = new Blob([zipped], { type: "application/zip" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filepath.split("/").pop();
        a.click();
        URL.revokeObjectURL(url);
    }
}

function readNiftiHeader(niftiPath) {
    if (!fs.existsSync(niftiPath)) {
        throw new Error("NIfTI file not found: " + niftiPath);
    }
    const buffer = fs.readFileSync(niftiPath);
    if (buffer.byteLength < 4) {
        throw new Error("Invalid NIfTI file: too small to contain header size");
    }
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const sizeof_hdr = view.getInt32(0, true);

    let isNifti1 = false;
    let isNifti2 = false;
    if (sizeof_hdr === 348) {
        if (buffer.byteLength < 348) throw new Error("Invalid NIfTI file: file smaller than expected NIfTI-1 header");
        isNifti1 = true;
    } else if (sizeof_hdr === 540) {
        if (buffer.byteLength < 540) throw new Error("Invalid NIfTI file: file smaller than expected NIfTI-2 header");
        isNifti2 = true;
    } else {
        throw new Error("Invalid NIfTI file: unknown sizeof_hdr " + sizeof_hdr);
    }

    let dim = [];
    let pixdim = [];
    let qform_code, sform_code;
    let quatern_b, quatern_c, quatern_d;
    let qoffset_x, qoffset_y, qoffset_z;
    let srow_x = [], srow_y = [], srow_z = [];

    if (isNifti1) {
        for(let i=0; i<8; i++) dim.push(view.getInt16(40 + i*2, true));
        for(let i=0; i<8; i++) pixdim.push(view.getFloat32(76 + i*4, true));
        qform_code = view.getInt16(252, true);
        sform_code = view.getInt16(254, true);
        quatern_b = view.getFloat32(256, true);
        quatern_c = view.getFloat32(260, true);
        quatern_d = view.getFloat32(264, true);
        qoffset_x = view.getFloat32(268, true);
        qoffset_y = view.getFloat32(272, true);
        qoffset_z = view.getFloat32(276, true);
        for(let i=0; i<4; i++) srow_x.push(view.getFloat32(280 + i*4, true));
        for(let i=0; i<4; i++) srow_y.push(view.getFloat32(296 + i*4, true));
        for(let i=0; i<4; i++) srow_z.push(view.getFloat32(312 + i*4, true));
    } else {
        for(let i=0; i<8; i++) dim.push(Number(view.getBigInt64(16 + i*8, true)));
        for(let i=0; i<8; i++) pixdim.push(view.getFloat64(80 + i*8, true));
        qform_code = view.getInt32(344, true);
        sform_code = view.getInt32(348, true);
        quatern_b = view.getFloat64(352, true);
        quatern_c = view.getFloat64(360, true);
        quatern_d = view.getFloat64(368, true);
        qoffset_x = view.getFloat64(376, true);
        qoffset_y = view.getFloat64(384, true);
        qoffset_z = view.getFloat64(392, true);
        for(let i=0; i<4; i++) srow_x.push(view.getFloat64(400 + i*8, true));
        for(let i=0; i<4; i++) srow_y.push(view.getFloat64(432 + i*8, true));
        for(let i=0; i<4; i++) srow_z.push(view.getFloat64(464 + i*8, true));
    }

    let DIMENSIONS = [dim[1], dim[2], dim[3]];
    let VOXEL_TO_RASMM = [];

    if (sform_code > 0) {
        VOXEL_TO_RASMM = [srow_x, srow_y, srow_z, [0, 0, 0, 1]];
    } else if (qform_code > 0) {
        let b = quatern_b;
        let c = quatern_c;
        let d = quatern_d;
        let a = Math.sqrt(Math.max(0, 1.0 - (b*b + c*c + d*d)));
        let qfac = pixdim[0] === 0 ? 1 : pixdim[0];
        let dx = pixdim[1];
        let dy = pixdim[2];
        let dz = pixdim[3];

        let R00 = a*a + b*b - c*c - d*d;
        let R01 = 2*(b*c - a*d);
        let R02 = 2*(b*d + a*c);
        let R10 = 2*(b*c + a*d);
        let R11 = a*a + c*c - b*b - d*d;
        let R12 = 2*(c*d - a*b);
        let R20 = 2*(b*d - a*c);
        let R21 = 2*(c*d + a*b);
        let R22 = a*a + d*d - c*c - b*b;

        VOXEL_TO_RASMM = [
            [R00 * dx, R01 * dy, R02 * qfac * dz, qoffset_x],
            [R10 * dx, R11 * dy, R12 * qfac * dz, qoffset_y],
            [R20 * dx, R21 * dy, R22 * qfac * dz, qoffset_z],
            [0, 0, 0, 1]
        ];
    } else {
        throw new Error("NIfTI file has no valid spatial transform");
    }

    return { DIMENSIONS, VOXEL_TO_RASMM };
}

async function writeZip64Stream(filepath, files) {
    const writeStream = fs.createWriteStream(filepath, { highWaterMark: 4 * 1024 * 1024 });

    async function writeChunk(buf) {
        if (!writeStream.write(buf)) {
            await new Promise((resolve, reject) => {
                const onDrain = () => {
                    writeStream.off('error', onError);
                    resolve();
                };
                const onError = (err) => {
                    writeStream.off('drain', onDrain);
                    reject(err);
                };
                writeStream.once('drain', onDrain);
                writeStream.once('error', onError);
            });
        }
    }

    let offset = 0n; // Use BigInt for >4GB offsets
    const centralDirectory = [];

    for (const [filename, data] of Object.entries(files)) {
        const nameBuf = Buffer.from(filename);
        const nameLen = nameBuf.length;
        const size = BigInt(data.byteLength || data.length);
        const useZip64 = size >= 0xFFFFFFFFn || offset >= 0xFFFFFFFFn;
        const dataU8 = new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength || data.length);
        const crc = nativeCrc32(dataU8);

        // Write Local File Header
        const lfhBuf = Buffer.alloc(30 + nameLen + (useZip64 ? 20 : 0));
        lfhBuf.writeUInt32LE(0x04034b50, 0); // LFH signature
        lfhBuf.writeUInt16LE(useZip64 ? 45 : 20, 4); // Version needed to extract
        lfhBuf.writeUInt16LE(0, 6); // General purpose bit flag
        lfhBuf.writeUInt16LE(0, 8); // Compression method (0 = stored)
        lfhBuf.writeUInt16LE(0, 10); // Last mod file time
        lfhBuf.writeUInt16LE(0, 12); // Last mod file date
        lfhBuf.writeUInt32LE(crc, 14); // CRC-32

        if (useZip64) {
            lfhBuf.writeUInt32LE(0xFFFFFFFF, 18); // Compressed size
            lfhBuf.writeUInt32LE(0xFFFFFFFF, 22); // Uncompressed size
            lfhBuf.writeUInt16LE(nameLen, 26); // File name length
            lfhBuf.writeUInt16LE(20, 28); // Extra field length
            nameBuf.copy(lfhBuf, 30);

            // ZIP64 Extra Field
            lfhBuf.writeUInt16LE(0x0001, 30 + nameLen);
            lfhBuf.writeUInt16LE(16, 32 + nameLen);
            lfhBuf.writeBigUInt64LE(size, 34 + nameLen); // Uncompressed size
            lfhBuf.writeBigUInt64LE(size, 42 + nameLen); // Compressed size
        } else {
            lfhBuf.writeUInt32LE(Number(size), 18); // Compressed size
            lfhBuf.writeUInt32LE(Number(size), 22); // Uncompressed size
            lfhBuf.writeUInt16LE(nameLen, 26); // File name length
            lfhBuf.writeUInt16LE(0, 28); // Extra field length
            nameBuf.copy(lfhBuf, 30);
        }

        await writeChunk(lfhBuf);

        // Write file data chunk by chunk (4 MB chunks)
        const CHUNK_SIZE = 4 * 1024 * 1024;
        let pos = 0;
        while (pos < dataU8.length) {
            const end = Math.min(pos + CHUNK_SIZE, dataU8.length);
            await writeChunk(dataU8.subarray(pos, end));
            pos = end;
        }

        centralDirectory.push({
            filename: nameBuf,
            size: size,
            offset: offset,
            crc: crc
        });

        offset += BigInt(lfhBuf.length) + size;
    }

    const cdStart = offset;
    let cdSize = 0n;

    for (const file of centralDirectory) {
        const nameLen = file.filename.length;
        const useZip64 = file.size >= 0xFFFFFFFFn || file.offset >= 0xFFFFFFFFn;

        let extraFieldLength = 0;
        if (useZip64) {
            extraFieldLength += 4;
            if (file.size >= 0xFFFFFFFFn) extraFieldLength += 16;
            if (file.offset >= 0xFFFFFFFFn) extraFieldLength += 8;
        }

        const cdBuf = Buffer.alloc(46 + nameLen + extraFieldLength);
        cdBuf.writeUInt32LE(0x02014b50, 0); // CD signature
        cdBuf.writeUInt16LE(45, 4); // Version made by
        cdBuf.writeUInt16LE(useZip64 ? 45 : 20, 6); // Version needed to extract
        cdBuf.writeUInt16LE(0, 8); // General purpose bit flag
        cdBuf.writeUInt16LE(0, 10); // Compression method
        cdBuf.writeUInt16LE(0, 12); // Last mod file time
        cdBuf.writeUInt16LE(0, 14); // Last mod file date
        cdBuf.writeUInt32LE(file.crc, 16); // CRC-32

        cdBuf.writeUInt32LE(file.size >= 0xFFFFFFFFn ? 0xFFFFFFFF : Number(file.size), 20); // Compressed size
        cdBuf.writeUInt32LE(file.size >= 0xFFFFFFFFn ? 0xFFFFFFFF : Number(file.size), 24); // Uncompressed size
        cdBuf.writeUInt16LE(nameLen, 28); // File name length
        cdBuf.writeUInt16LE(extraFieldLength, 30); // Extra field length
        cdBuf.writeUInt16LE(0, 32); // File comment length
        cdBuf.writeUInt16LE(0, 34); // Disk number start
        cdBuf.writeUInt16LE(0, 36); // Internal file attributes
        cdBuf.writeUInt32LE(0, 38); // External file attributes
        cdBuf.writeUInt32LE(file.offset >= 0xFFFFFFFFn ? 0xFFFFFFFF : Number(file.offset), 42); // Relative offset of LFH

        file.filename.copy(cdBuf, 46);

        if (useZip64) {
            let pos = 46 + nameLen;
            cdBuf.writeUInt16LE(0x0001, pos); // Tag
            cdBuf.writeUInt16LE(extraFieldLength - 4, pos + 2); // Size
            pos += 4;
            if (file.size >= 0xFFFFFFFFn) {
                cdBuf.writeBigUInt64LE(file.size, pos);
                cdBuf.writeBigUInt64LE(file.size, pos + 8);
                pos += 16;
            }
            if (file.offset >= 0xFFFFFFFFn) {
                cdBuf.writeBigUInt64LE(file.offset, pos);
            }
        }

        await writeChunk(cdBuf);
        cdSize += BigInt(cdBuf.length);
    }

    const totalEntries = BigInt(centralDirectory.length);
    const useZip64Eocd = totalEntries >= 0xFFFFn || cdStart >= 0xFFFFFFFFn || cdSize >= 0xFFFFFFFFn;

    if (useZip64Eocd) {
        // ZIP64 EOCD
        const eocd64Buf = Buffer.alloc(56);
        eocd64Buf.writeUInt32LE(0x06064b50, 0); // ZIP64 EOCD signature
        eocd64Buf.writeBigUInt64LE(44n, 4); // Size of ZIP64 EOCD record
        eocd64Buf.writeUInt16LE(45, 12); // Version made by
        eocd64Buf.writeUInt16LE(45, 14); // Version needed to extract
        eocd64Buf.writeUInt32LE(0, 16); // Number of this disk
        eocd64Buf.writeUInt32LE(0, 20); // Disk where CD starts
        eocd64Buf.writeBigUInt64LE(totalEntries, 24); // Number of CD records on this disk
        eocd64Buf.writeBigUInt64LE(totalEntries, 32); // Total number of CD records
        eocd64Buf.writeBigUInt64LE(cdSize, 40); // Size of CD
        eocd64Buf.writeBigUInt64LE(cdStart, 48); // Offset of start of CD
        await writeChunk(eocd64Buf);

        // ZIP64 EOCD Locator
        const locBuf = Buffer.alloc(20);
        locBuf.writeUInt32LE(0x07064b50, 0); // ZIP64 EOCD locator signature
        locBuf.writeUInt32LE(0, 4); // Number of the disk with the start of the zip64 end of central directory
        locBuf.writeBigUInt64LE(offset + cdSize, 8); // Relative offset of the zip64 end of central directory record
        locBuf.writeUInt32LE(1, 16); // Total number of disks
        await writeChunk(locBuf);
    }

    // Standard EOCD
    const eocdBuf = Buffer.alloc(22);
    eocdBuf.writeUInt32LE(0x06054b50, 0); // EOCD signature
    eocdBuf.writeUInt16LE(0, 4); // Number of this disk
    eocdBuf.writeUInt16LE(0, 6); // Disk where CD starts
    eocdBuf.writeUInt16LE(totalEntries >= 0xFFFFn ? 0xFFFF : Number(totalEntries), 8); // Number of CD records on this disk
    eocdBuf.writeUInt16LE(totalEntries >= 0xFFFFn ? 0xFFFF : Number(totalEntries), 10); // Total number of CD records
    eocdBuf.writeUInt32LE(cdSize >= 0xFFFFFFFFn ? 0xFFFFFFFF : Number(cdSize), 12); // Size of CD
    eocdBuf.writeUInt32LE(cdStart >= 0xFFFFFFFFn ? 0xFFFFFFFF : Number(cdStart), 16); // Offset of start of CD
    eocdBuf.writeUInt16LE(0, 20); // ZIP file comment length
    await writeChunk(eocdBuf);

    await new Promise((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
        writeStream.end();
    });
}

export { readTRK, readTCK, readVTK, readTRX, readTT, saveTCK, saveTRK, saveVTK, saveTRX, readNiftiHeader };

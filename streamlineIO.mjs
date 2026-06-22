//Install dependencies
// npm install gl-matrix fflate fzstd

export { readTRK, readTCK, readVTK, readTRX, readTT, saveTCK, saveTRK, saveVTK, saveTRX };
import { mat3, mat4, vec3, vec4 } from "gl-matrix"; //for trk
import * as fs from "fs";
import * as fflate from "fflate";
import * as fzstd from 'fzstd'; //https://github.com/101arrowz/fzstd

function alert(str) { //for node.js which does not have a GUI alert
  console.log(str);
  process.exit()
}

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
    for (let i = 0; i < npt / 3; i++) {
      const pos = vec4.fromValues(pts[v], pts[v+1], pts[v+2], 1)
      vec4.transformMat4(pos, pos, vox2mmMat)
      pts[v++] = pos[0]
      pts[v++] = pos[1]
      pts[v++] = pos[2]
    }
    offsetPt0[pos.length] = npt / 3; //solve fence post problem, offset for final streamline
  } // parse_tt()
  parse_tt(mat.track)
  return {
    pts,
    offsetPt0,
  }
} // readTT()

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
  let totalWords = dataView.byteLength / 4;

  let num_streamlines = 0;
  let num_points = 0;
  let w = 0;
  while (w < totalWords) {
    let n_pts = dataView.getInt32(w * 4, true);
    num_streamlines++;
    num_points += n_pts;
    w += 1 + n_pts * (3 + n_scalars) + n_properties;
  }

  let offsetPt0 = new Uint32Array(num_streamlines + 1);
  let pts = new Float32Array(num_points * 3);

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
          dpv[s].vals.push(dataView.getFloat32(w * 4, true));
          w++;
        }
      }
      npt++;
    } // for j: each point in streamline
    if (n_properties > 0) {
      for (let j = 0; j < n_properties; j++) {
        dps[j].vals.push(dataView.getFloat32(w * 4, true));
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
  pts = pts.slice(0, npt3);
  offsetPt0 = offsetPt0.slice(0, noffset); 
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
    alert("Invalid VTK image");
  if (!lines[2].startsWith("ASCII")) alert("Not ASCII VTK mesh");
  let pos = 3;
  while (lines[pos].length < 1) pos++; //skip blank lines
  if (!lines[pos].includes("POLYDATA")) alert("Not ASCII VTK polydata");
  pos++;
  while (lines[pos].length < 1) pos++; //skip blank lines
  if (!lines[pos].startsWith("POINTS")) alert("Not VTK POINTS");
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
    if (n_count < 1) alert("Corrupted VTK ASCII");
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
  } else alert("Unsupported ASCII VTK datatype " + items[0]);
  var indices = new Int32Array(tris);
  return {
    positions,
    indices,
  };
} // readTxtVTK()

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
  if (!line.startsWith("# vtk DataFile")) alert("Invalid VTK mesh");
  line = readStr(); //2nd line comment
  line = readStr(); //3rd line ASCII/BINARY
  if (line.startsWith("ASCII")) return readTxtVTK(buffer); //from NiiVue
  else if (!line.startsWith("BINARY"))
    alert("Invalid VTK image, expected ASCII or BINARY", line);
  line = readStr(); //5th line "DATASET POLYDATA"
  if (!line.includes("POLYDATA")) alert("Only able to read VTK POLYDATA", line);
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
    //tractogaphy data: detect if borked by DiPy
    let posOK = pos;
    line = readStr(); //borked files "OFFSETS vtktypeint64"
    if (line.startsWith("OFFSETS")) {
      //console.log("invalid VTK file created by DiPy");
      let isInt64 = false;
      if (line.includes("int64")) isInt64 = true;
      let offsetPt0 = new Uint32Array(n_count);
      if (isInt64) {
        let isOverflowInt32 = false;
        for (let c = 0; c < n_count; c++) {
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
        for (let c = 0; c < n_count; c++) {
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
  } else alert("Unsupported ASCII VTK datatype ", items[0]);
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
      const chunkSize = 512 * 1024 * 1024;
      let offset = 0;
      while (offset < size) {
        const bytesToRead = Math.min(chunkSize, size - offset);
        const bytesRead = fs.readSync(fd, uint8Array, offset, bytesToRead, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      fs.closeSync(fd);
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
  const sizeMap = getZip64OriginalSizes(data);
  const decompressed = fflate.unzipSync(data, {
    filter(file) {
      return file.originalSize > 0;
    }
  });
  var keys = Object.keys(decompressed);
  for (var i = 0, len = keys.length; i < len; i++) {
    let parts = keys[i].split("/");
    let fname = parts.slice(-1)[0]; // my.trx/dpv/fx.float32 -> fx.float32
    if (fname.startsWith(".")) continue;
    let pname = parts.slice(-2)[0]; // my.trx/dpv/fx.float32 -> dpv
    let tag = fname.split(".")[0]; // "positions.3.float16 -> "positions"
    //todo: should tags be censored for invalide characters: https://stackoverflow.com/questions/8676011/which-characters-are-valid-invalid-in-a-json-key-name
    let data = decompressed[keys[i]];
    // Truncate to the size recorded in the ZIP central directory to work
    // around a fflate ZIP64 bug where extra bytes from subsequent entries
    // are appended to the decompressed output.
    const correctByteLength = sizeMap[keys[i]];
    if (correctByteLength !== undefined && data.byteLength > correctByteLength) {
      data = data.slice(0, correctByteLength);
    }
    if (fname.includes("header.json")) {
      let jsonString = new TextDecoder().decode(data);
      // Strip UTF-8 BOM if present (some tools prepend \uFEFF)
      if (jsonString.charCodeAt(0) === 0xFEFF) jsonString = jsonString.slice(1);
      header = JSON.parse(jsonString.trim());
      continue;
    }


    //next read arrays for all possible datatypes: int8/16/32/64 uint8/16/32/64 float16/32/64
    let nval = 0;
    let vals = [];
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
    if (parts[0] === "dpg") {
      dpg.push({
        id: parts[1] + "/" + tag, // e.g. "AF_R/volume"
        fname: parts.slice(1).join("/"), // e.g. "AF_R/volume.uint32"
        vals: vals.slice(),
      });
      continue;
    }
    //next: read groups
    if (pname === "groups") {
      groups.push({
        id: tag,
        fname: fname,
        vals: vals.slice(),
      });
      continue;
    }
    //next: read data_per_vertex
    if (pname.includes("dpv")) {
      dpv.push({
        id: tag,
        fname: fname,
        vals: vals.slice(),
      });
      continue;
    }
    //next: read data_per_streamline
    if (pname.includes("dps")) {
      dps.push({
        id: tag,
        fname: fname,
        vals: vals.slice(),
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
      pts = vals.slice();
      if (fname.endsWith(".float64")) positions_dtype = "float64";
      else if (fname.endsWith(".float16")) positions_dtype = "float16";
      else positions_dtype = "float32";
    }
  }
  if (noff === 0 || npt === 0) alert("Failure reading TRX format");
  if (isOverflowUint64)
    alert("Too many vertices: JavaScript does not support 64 bit integers");

  if (offsetPt0[noff - 1] === npt / 3) {
    offsetPt0 = offsetPt0.slice(0, noff);
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
function encodeFloat16(val) {
    const floatView = new Float32Array(1);
    const int32View = new Int32Array(floatView.buffer);
    floatView[0] = val;
    const f = int32View[0];
    
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

function saveTRK(filepath, obj, originalFilename) {
    const fd = fs.openSync(filepath, 'w');
    const headerBytes = new Uint8Array(1000);
    const view = new DataView(headerBytes.buffer);

    headerBytes.set([84, 82, 65, 67, 75], 0);

    let dim = [256, 256, 256];
    let voxelSize = [1, 1, 1];
    let voxToRas = [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1]
    ];

    if (obj.header) {
        if (obj.header.DIMENSIONS) dim = obj.header.DIMENSIONS;
        if (obj.header.VOXEL_TO_RASMM) {
            voxToRas = obj.header.VOXEL_TO_RASMM;
            voxelSize = [
                Math.sqrt(voxToRas[0][0]**2 + voxToRas[1][0]**2 + voxToRas[2][0]**2),
                Math.sqrt(voxToRas[0][1]**2 + voxToRas[1][1]**2 + voxToRas[2][1]**2),
                Math.sqrt(voxToRas[0][2]**2 + voxToRas[1][2]**2 + voxToRas[2][2]**2)
            ];
        }
    }

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

    headerBytes.set([82, 65, 83, 0], 948);

    let invMat = null;
    if (obj.header && obj.header.VOXEL_TO_RASMM) {
        let mat = mat4.fromValues(
            voxToRas[0][0], voxToRas[1][0], voxToRas[2][0], voxToRas[3][0],
            voxToRas[0][1], voxToRas[1][1], voxToRas[2][1], voxToRas[3][1],
            voxToRas[0][2], voxToRas[1][2], voxToRas[2][2], voxToRas[3][2],
            voxToRas[0][3], voxToRas[1][3], voxToRas[2][3], voxToRas[3][3]
        );
        invMat = mat4.create();
        mat4.invert(invMat, mat);
    }

    const numStreamlines = obj.offsetPt0.length - 1;
    view.setInt32(988, numStreamlines, true);
    view.setInt32(992, 2, true);
    view.setInt32(996, 1000, true);

    fs.writeSync(fd, headerBytes);

    const chunkSize = 16 * 1024 * 1024;
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
            let vx = x, vy = y, vz = z;

            if (invMat) {
                let cx = x * invMat[0] + y * invMat[4] + z * invMat[8] + invMat[12];
                let cy = x * invMat[1] + y * invMat[5] + z * invMat[9] + invMat[13];
                let cz = x * invMat[2] + y * invMat[6] + z * invMat[10] + invMat[14];

                vx = (cx + 0.5) * voxelSize[0];
                vy = (cy + 0.5) * voxelSize[1];
                vz = (cz + 0.5) * voxelSize[2];
            } else {
                vx = x + 0.5;
                vy = y + 0.5;
                vz = z + 0.5;
            }

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

function saveTRX(filepath, obj, originalFilename) {
    let dtype = obj.positions_dtype || "float32";
    let ptsData = obj.pts;
    if (ptsData instanceof Float64Array) {
        dtype = "float64";
    }

    if (originalFilename.includes("f16") || dtype === "float16") {
        dtype = "float16";
        ptsData = float32ToFloat16(obj.pts);
    } else if (originalFilename.includes("f64")) {
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

    if (obj.header) {
        header.VOXEL_TO_RASMM = obj.header.VOXEL_TO_RASMM || header.VOXEL_TO_RASMM;
        header.DIMENSIONS = obj.header.DIMENSIONS || header.DIMENSIONS;
    }

    const zipObj = {};
    zipObj["header.json"] = fflate.strToU8(JSON.stringify(header, null, 4));
    zipObj[`positions.3.${dtype}`] = new Uint8Array(ptsData.buffer, ptsData.byteOffset, ptsData.byteLength);
    
    let offsetDtype = "uint32";
    let offsetData = obj.offsetPt0.subarray(0, numStreamlines + 1);
    if (originalFilename.includes("ui64")) {
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

    const zipped = fflate.zipSync(zipObj);
    fs.writeFileSync(filepath, zipped);
}

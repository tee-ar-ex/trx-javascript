# Supported Formats

## TRX

The modern tractography format developed through community discussions to
address limitations of earlier formats. Supports data-per-vertex,
data-per-streamline, data-per-group, and arbitrary JSON metadata.

- **Specification**: [TRX spec on GitHub](https://github.com/tee-ar-ex/trx-spec/blob/master/specifications.md)
- **Extension**: `.trx` (zip container)
- **Data types**: float16/32/64, int8/16/32/64, uint8/16/32/64
- **Decompression**: Zip container via `fflate`

## TRK (TrackVis)

The popular TrackVis format, widely used in diffusion MRI.

- **Specification**: [TrackVis file format](http://trackvis.org/docs/?subsect=fileformat)
- **Extension**: `.trk`, `.trk.gz`, `.trk.zst`
- **Decompression**: gzip via `fflate`, zstd via `fzstd`
- **Coordinate transform**: Applies voxel-to-RAS matrix from header

## TCK (MRtrix)

The MRtrix track file format.

- **Specification**: [MRtrix documentation](https://mrtrix.readthedocs.io/en/latest/getting_started/image_data.html#tracks-file-format-tck)
- **Extension**: `.tck`
- **Streamline termination**: NaN = continue to next streamline; Infinity = end of data

## VTK (Legacy)

The VTK legacy file format, supporting both ASCII and binary POLYDATA.

- **Specification**: [VTK file format](https://vtk.org/wp-content/uploads/2015/04/file-formats.pdf)
- **Extension**: `.vtk`
- **Cell types**: LINES (streamlines), TRIANGLE_STRIPS, POLYGONS
- **DiPy compatibility**: Detects and handles DiPy's OFFSETS-style LINES
- **Byte order**: Binary VTK uses big-endian

## TT (DSI Studio)

The DSI Studio format, stored inside a Matlab V4 container.

- **Documentation**: [DSI Studio data](https://dsi-studio.labsolver.org/doc/cli_data.html)
- **Extension**: `.tt`, `.fib`
- **Encoding**: Incremental zigzag delta encoding
- **Precision**: Positions stored as 1/32nd of a voxel (slightly lossy)

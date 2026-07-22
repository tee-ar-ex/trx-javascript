# Implementation Notes

## Float16 Conversion

The TRX specification allows streamline positions to use the float16 datatype,
which is not native to JavaScript. This code converts float16 values to float32
using a lookup table for performance.

## Fencepost Problem

The TRX specification stores NB_STREAMLINES values in the offsets array, with
each value pointing to the start of that streamline. One must use the length of
the positions array or the header to infer the end of the final streamline.

This code returns an offset array with NB_STREAMLINES + 1 values to solve the
[fencepost problem](https://icarus.cs.weber.edu/~dab/cs1410/textbook/3.Control/fencepost.html)
for the final streamline. This simplifies and accelerates display code, but you
must be aware of this modification when comparing with other implementations.

## Endianness

The TRX specification requires little-endian byte order. The current code only
supports little-endian systems, which covers all modern Android, iOS, macOS,
Linux, and Windows devices.

## Decompression

- **gzip / zip**: Uses [fflate](https://github.com/101arrowz/fflate), which is
  significantly faster than the pako and jszip alternatives.
- **zstd**: Uses [fzstd](https://github.com/101arrowz/fzstd) for zstd-compressed
  TRK files.

## 64-bit Integer Limitation

JavaScript does not natively support 64-bit integers. For uint64 and int64 data
in TRX files, only the lower 32 bits are read. A warning is raised if any value
exceeds the 32-bit range.

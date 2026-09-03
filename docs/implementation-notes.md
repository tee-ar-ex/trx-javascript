# Implementation Notes

## Float16 Conversion

The TRX specification allows streamline positions to use the float16 datatype,
which is not native to JavaScript. This code converts float16 values to float32
using a lookup table for performance.

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

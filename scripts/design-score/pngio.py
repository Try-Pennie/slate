"""pngio.py: read and write PNG pictures with nothing but the standard library (claude-config#1364).

The design match score compares screenshots pixel by pixel. Pillow would do it, but it is not on
every Mac or on CI, and the score must give the same answer wherever it runs, so it reads PNGs here.
Measured on 2026-10-19 (Python 3.14, Daniels-MacBook-Pro-2): undoing the Paeth filter, the slowest,
costs about 1 ms a row of 1280 RGBA pixels, so about 2 seconds for a 1280 by 2000 screenshot; the
other filters are faster. A screenshot is read once per score.

read_png(path) -> (width, height, rgba): every pixel as 8 bit RGBA bytes, row by row, whatever the
file held (grey, grey with alpha, RGB, palette, RGBA; 8 or 16 bits, 16 kept to its high byte; a
palette's tRNS alpha, and a grey or RGB picture's tRNS colour key, honoured). Anything it cannot read faithfully raises PngError naming the file
and why: an interlaced file, a bit depth below 8, a broken or truncated file. It never guesses.

write_png(path, width, height, rgba): an 8 bit RGBA file, every row unfiltered.
"""
import struct
import zlib

SIGNATURE = b"\x89PNG\r\n\x1a\n"
CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}


class PngError(Exception):
    pass


def _paeth_row(row, prev, bpp):
    out = row
    for i in range(len(out)):
        a = out[i - bpp] if i >= bpp else 0
        b = prev[i]
        c = prev[i - bpp] if i >= bpp else 0
        p = a + b - c
        pa = p - a if p >= a else a - p
        pb = p - b if p >= b else b - p
        pc = p - c if p >= c else c - p
        if pa <= pb and pa <= pc:
            pr = a
        elif pb <= pc:
            pr = b
        else:
            pr = c
        out[i] = (out[i] + pr) & 255


def _unfilter(data, height, stride, bpp, path):
    rows = []
    prev = bytearray(stride)
    pos = 0
    for y in range(height):
        if pos + 1 + stride > len(data):
            raise PngError("%s: the picture data ends at row %d of %d" % (path, y, height))
        kind = data[pos]
        row = bytearray(data[pos + 1:pos + 1 + stride])
        pos += 1 + stride
        if kind == 0:
            pass
        elif kind == 1:
            for i in range(bpp, stride):
                row[i] = (row[i] + row[i - bpp]) & 255
        elif kind == 2:
            for i in range(stride):
                row[i] = (row[i] + prev[i]) & 255
        elif kind == 3:
            for i in range(stride):
                left = row[i - bpp] if i >= bpp else 0
                row[i] = (row[i] + ((left + prev[i]) >> 1)) & 255
        elif kind == 4:
            _paeth_row(row, prev, bpp)
        else:
            raise PngError("%s: row %d uses filter %d, which PNG does not define" % (path, y, kind))
        rows.append(row)
        prev = row
    return rows


def read_png(path):
    try:
        with open(path, "rb") as fh:
            blob = fh.read()
    except OSError as err:
        raise PngError("%s: could not be read (%s)" % (path, err.strerror or err))
    if not blob.startswith(SIGNATURE):
        raise PngError("%s: is not a PNG file" % path)
    pos = len(SIGNATURE)
    header = None
    palette = None
    trns = None
    idat = []
    ended = False
    while pos + 8 <= len(blob):
        length, kind = struct.unpack(">I4s", blob[pos:pos + 8])
        body = blob[pos + 8:pos + 8 + length]
        if len(body) != length or pos + 12 + length > len(blob):
            raise PngError("%s: is cut short inside its %s chunk" % (path, kind.decode("latin-1")))
        crc = struct.unpack(">I", blob[pos + 8 + length:pos + 12 + length])[0]
        if zlib.crc32(kind + body) & 0xFFFFFFFF != crc:
            raise PngError("%s: its %s chunk is damaged (checksum does not match)" % (path, kind.decode("latin-1")))
        if kind == b"IHDR":
            header = struct.unpack(">IIBBBBB", body)
        elif kind == b"PLTE":
            palette = body
        elif kind == b"tRNS":
            trns = body
        elif kind == b"IDAT":
            idat.append(body)
        elif kind == b"IEND":
            ended = True
            break
        pos += 12 + length
    if header is None:
        raise PngError("%s: has no header (IHDR)" % path)
    if not ended:
        raise PngError("%s: is cut short (no IEND)" % path)
    width, height, depth, colortype, _compression, _filter, interlace = header
    if interlace:
        raise PngError("%s: is interlaced, which this reader does not decode; write the picture without interlacing" % path)
    if colortype not in CHANNELS:
        raise PngError("%s: has colour type %d, which PNG does not define" % (path, colortype))
    if depth not in (8, 16) or (colortype == 3 and depth != 8):
        raise PngError("%s: has bit depth %d for colour type %d; only 8 bit (and 16 bit outside a palette) is read"
                       % (path, depth, colortype))
    if colortype == 3 and not palette:
        raise PngError("%s: is a palette picture with no palette" % path)
    try:
        data = zlib.decompress(b"".join(idat))
    except zlib.error as err:
        raise PngError("%s: its picture data could not be decompressed (%s)" % (path, err))
    channels = CHANNELS[colortype]
    bpp = channels * depth // 8
    stride = width * bpp
    rows = _unfilter(data, height, stride, bpp, path)

    out = bytearray()
    if colortype == 3:
        table = []
        for i in range(len(palette) // 3):
            alpha = trns[i] if trns is not None and i < len(trns) else 255
            table.append(bytes((palette[3 * i], palette[3 * i + 1], palette[3 * i + 2], alpha)))
        for row in rows:
            for index in row:
                if index >= len(table):
                    raise PngError("%s: a pixel names palette entry %d of %d" % (path, index, len(table)))
                out += table[index]
        return width, height, bytes(out)
    # A colour key (tRNS on a grey or RGB picture) names the one sample value drawn transparent,
    # compared at the file's full depth, before a 16 bit sample is cut to its high byte.
    key = None
    if trns is not None and colortype in (0, 2):
        need = 2 if colortype == 0 else 6
        if len(trns) != need:
            raise PngError("%s: its tRNS chunk is %d bytes, and a colour type %d key is %d" % (path, len(trns), colortype, need))
        values = struct.unpack(">%dH" % (need // 2), trns)
        if depth == 16:
            key = trns
        elif all(v < 256 for v in values):
            key = bytes(values)
        # else a key above 255 matches no 8 bit pixel, so none is drawn transparent
    for row in rows:
        keyed = None
        if key:
            step = len(key)
            keyed = [row[i:i + step] == key for i in range(0, len(row), step)]
        if depth == 16:
            row = row[0::2]  # the high byte of every sample
        alpha = bytes(0 if k else 255 for k in keyed) if keyed is not None else b"\xff" * width
        if colortype == 6:
            out += row
        elif colortype == 2:
            rgba = bytearray(width * 4)
            rgba[0::4] = row[0::3]
            rgba[1::4] = row[1::3]
            rgba[2::4] = row[2::3]
            rgba[3::4] = alpha
            out += rgba
        elif colortype == 0:
            rgba = bytearray(width * 4)
            rgba[0::4] = row
            rgba[1::4] = row
            rgba[2::4] = row
            rgba[3::4] = alpha
            out += rgba
        else:  # 4, grey with alpha
            rgba = bytearray(width * 4)
            grey = row[0::2]
            rgba[0::4] = grey
            rgba[1::4] = grey
            rgba[2::4] = grey
            rgba[3::4] = row[1::2]
            out += rgba
    return width, height, bytes(out)


def _chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def write_png(path, width, height, rgba):
    stride = width * 4
    if len(rgba) != stride * height:
        raise PngError("%s: %d bytes of pixels do not fill a %d by %d picture" % (path, len(rgba), width, height))
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        raw += rgba[y * stride:(y + 1) * stride]
    blob = (SIGNATURE + _chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + _chunk(b"IDAT", zlib.compress(bytes(raw), 6)) + _chunk(b"IEND", b""))
    with open(path, "wb") as fh:
        fh.write(blob)

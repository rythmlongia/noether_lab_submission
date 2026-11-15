#!/usr/bin/env node
// Writes corrupted copies of a valid .ayr file for manual testing of the app.
// Usage: node tools/make_broken_files.js <valid.ayr> <outdir>
'use strict';
const fs = require('fs'), path = require('path');
const { writeAyr, tetra } = require('../tests/ayrWriter.js');
const [src, out] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const good = fs.readFileSync(src);
const w = (name, buf) => { fs.writeFileSync(path.join(out, name), buf); console.log(name, buf.length); };
w('truncated_last_byte.ayr', good.subarray(0, good.length - 1));
w('truncated_half.ayr', good.subarray(0, good.length >> 1));
w('tiny_10_bytes.ayr', good.subarray(0, 10));
const flip = (off) => { const b = Buffer.from(good); b[off] ^= 0x01; return b; };
w('one_byte_flipped_in_positions.ayr', flip(200));
w('one_byte_flipped_in_temperatures.ayr', flip(good.length - 100));
const m = Buffer.from(good); m[0] = 0x42; w('bad_magic.ayr', m);
const f = Buffer.from(good); f[4] |= 0x04; w('reserved_flag_bit.ayr', f);
const u = Buffer.from(good); u[5] = 7; w('bad_units.ayr', u);
w('extra_trailing_byte.ayr', Buffer.concat([good, Buffer.from([0])]));
// Files that are internally consistent (correct CRC) but break other rules:
w('triangle_index_out_of_range.ayr', writeAyr(tetra({ triangles: [0, 1, 2, 0, 1, 3, 0, 3, 2, 1, 2, 9] })));
w('times_not_increasing.ayr', writeAyr(tetra({ times: [5, 5] })));
w('version_2.ayr', writeAyr(tetra({ version: 2 })));
// A VALID file whose case name is HTML (for the XSS check in Task 3a)
w('valid_html_case_name.ayr', writeAyr(tetra({ name: '<img src=x onerror="alert(1)">', bigEndian: true })));

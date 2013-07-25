/*
 * FuzzSource: a Readable stream that emits "size" bytes of random data.
 * It also makes the raw buffer of the entire data stream available.  (It's
 * therefore not streaming, and requires buffering everything in memory.)
 */

var mod_util = require('util');
var mod_stream = require('stream');
if (!mod_stream.Transform)
	/* 0.8 shim */
	mod_stream = require('readable-stream');

module.exports = FuzzSource;

function FuzzSource(size, options)
{
	var buf, i;

	buf = new Buffer(size);
	for (i = 0; i < size; i++)
		buf[i] = 65 + Math.floor(Math.random() * 26);

	this.ds_emitted = 0;
	this.ds_buf = buf;

	mod_stream.Readable.call(this, options);
}

mod_util.inherits(FuzzSource, mod_stream.Readable);

FuzzSource.prototype._read = function (sz)
{
	var count, b, i;

	count = Math.min(this.ds_buf.length - this.ds_emitted, sz);
	if (count === 0) {
		this.push(null);
		return;
	}

	b = new Buffer(count);
	for (i = 0; i < count; i++)
		b[i] = this.ds_buf[this.ds_emitted + i];
	this.ds_emitted += count;
	this.push(b);
};

FuzzSource.prototype.rawbuf = function ()
{
	return (this.ds_buf);
};

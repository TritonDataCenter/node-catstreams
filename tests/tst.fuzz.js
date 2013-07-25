/*
 * tst.fuzz.js: exercise other edge cases of CatStreams using randomly-generated
 * data and a FuzzStream to mess with chunking and timing.
 */

var mod_assert = require('assert');
var mod_bunyan = require('bunyan');
var mod_crypto = require('crypto');

var CatStreams = require('../lib/catstreams');
var FuzzStream = require('fuzzstream');
var FuzzSource = require('./fuzzsource');

/* test parameters */
var nstreams = 500;			/* number of random streams */
var maxsize = 1024 * 1024;		/* maximum stream size */
var pzero = 0.2;			/* prob of each stream being empty */
var perRequestBuffer = 256 * 1024;	/* CatStreams request buffer */
var concurrencyLimit = 50;		/* CatStreams concurrency limit */

/* test state */
var streams = [];
var catstream, catmd5, calcmd5;
var log = new mod_bunyan({
    'name': 'tst.fuzz.js',
    'level': process.env['LOG_LEVEL'] || 'info',
    'serializers': {}
});
var calctotal, cattotal;
var i, sz, s, to;

/*
 * Setup the test by generating the input streams.  These are FuzzSources, which
 * generate random data.  The size of each source is also determined randomly.
 * This makes it a little non-trivial to debug, but more likely to cover more
 * cases.  If debugging becomes a problem, we could switch to a random number
 * generator that can be seeded and print the seed out here so we can reproduce
 * a failed test.
 */
calcmd5 = mod_crypto.createHash('md5');
catmd5 = mod_crypto.createHash('md5');
catstream = new CatStreams({
    'log': log,
    'perRequestBuffer': perRequestBuffer,
    'maxConcurrency': concurrencyLimit
});

process.stderr.write('generating test cases ... ');

calctotal = 0;
for (i = 0; i < nstreams; i++) {
	if (Math.random() < pzero)
		sz = 0;
	else
		sz = Math.floor(Math.random() * maxsize);

	s = new FuzzSource(sz, { 'highWaterMark': perRequestBuffer });
	calcmd5.update(s.rawbuf());
	calctotal += sz;
	streams.push(s);
}

for (i = 0; i < nstreams; i++) {
	(function (j) {
		catstream.cat(function () {
			var s2 = new FuzzStream();
			streams[j].pipe(s2);
			return (s2);
		});
	})(i);
}
catstream.cat(null);

console.error('done.');
console.error('executing test ... ');
to = setInterval(function () {
	console.error('read %d of %d bytes (%d%%)', cattotal, calctotal,
	    Math.floor(cattotal / calctotal * 100));
}, 5000);

cattotal = 0;
catstream.on('data', function (chunk) {
	cattotal += chunk.length;
	catmd5.update(chunk);
});

catstream.on('end', function () {
	clearInterval(to);
	mod_assert.equal(streams.length, nstreams);

	var expected = calcmd5.digest('base64');
	var actual = catmd5.digest('base64');
	console.log('%d streams', nstreams);
	console.log('expected bytes: %d', calctotal);
	console.log('actual   bytes: %d', cattotal);
	console.log('expected md5:   %s', expected);
	console.log('actual md5:     %s', actual);
	mod_assert.equal(actual, expected);
	console.log('TEST PASSED');
});

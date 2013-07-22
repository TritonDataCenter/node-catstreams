/*
 * tst.catstreams.js: exercise both common and edge cases of CatStreams, using
 *    an httpstream as the example stream.
 */

var mod_assert = require('assert');
var mod_crypto = require('crypto');
var mod_http = require('http');
var mod_path = require('path');
var mod_util = require('util');

var mod_bunyan = require('bunyan');
var CatStreams = require('../lib/catstreams');
var HttpStream = require('httpstream');
var mod_restify = require('restify');
var mod_vasync = require('vasync');
var mod_verror = require('verror');

var mod_stream = require('stream');
if (!mod_stream.Transform)
	/* 0.8 shim */
	mod_stream = require('readable-stream');

var VError = mod_verror.VError;

/* catstream parameters */
var perRequestBuffer = 10 * 1024 * 1024;
var concurrencyLimit = 100;

/* test case parameters */
var bigRequestSize = 256 * 1024 * 1024;

/* server parameters */
var srvRequestDelay = 0;
var srvLongDelay = 5000;

/* server state */
var srvConcurr = 0;
var srvConcurrMaxSeen = 0;

var log, serv1, serv2;
var clients = {};

var test_cases = {
    'basic': {
	/* basic case: a sequence of small resources */
	'resources': [ {
	    'server': 'http://localhost:8123',
	    'path': '/file1'
	}, {
	    'server': 'http://localhost:8125',
	    'path': '/file2'
	}, {
	    'server': 'http://localhost:8123',
	    'path': '/file3'
	} ],
	'expected': [
	    '"8123/file1"',
	    '"8125/file2"',
	    '"8123/file3"'
	].join('')
    },

    'error': {
	/* basic error case: one of the resources cannot be fetched */
	'resources': [ {
	    'server': 'http://localhost:8123',
	    'path': '/file1'
	}, {
	    'server': 'http://localhost:8124',
	    'path': '/file2'
	}, {
	    'server': 'http://localhost:8123',
	    'path': '/file3'
	} ],
	'error': /connect ECONNREFUSED/
    },

    'many_objects': {
	/*
	 * Tests that when fetching a very large number of small resources, we
	 * only fetch at most N at a time.
	 */
	'pre': function (t) {
		var i;
		srvConcurr = srvConcurrMaxSeen = 0;
		for (i = 0; i < 2000; i++) {
			this.resources.push({
			    'server': 'http://localhost:8123',
			    'path': '/file1'
			});
			this.expected += '"8123/file1"';
		}
		mod_assert.equal(this.resources.length, 2000);
	},
	'post': function () {
		mod_assert.ok(srvConcurrMaxSeen > concurrencyLimit / 2);
		mod_assert.ok(srvConcurrMaxSeen <= concurrencyLimit);
	},
	'resources': [],
	'expected': ''
    },

    'big_objects': {
	/*
	 * Tests that we don't buffer too much data for a single object.  We do
	 * this by fetching a small but slow object, followed by a large one
	 * (forcing the client to buffer the large one), and making sure our
	 * memory usage never exceeds a fixed size.
	 */
	'resources': [ {
	    'server': 'http://localhost:8123',
	    'path': '/slow'
	}, {
	    'server': 'http://localhost:8123',
	    'path': '/large'
	} ],
	'expected_size': '"8123/slow"'.length + bigRequestSize
    }
};

log = new mod_bunyan({
    'name': 'tst.catstream.js',
    'level': process.env['LOG_LEVEL'] || 'info',
    'serializers': {}
});

serv1 = mod_restify.createServer({ 'name': 'serv1', 'log': log });
serv1.get('/.*', handleRequest.bind(null, serv1));
serv1.on('uncaughtException', function (_1, _2, _3, err) { throw (err); });

serv2 = mod_restify.createServer({ 'name': 'serv2', 'log': log });
serv2.get('/.*', handleRequest.bind(null, serv2));
serv2.on('uncaughtException', function (_1, _2, _3, err) { throw (err); });

mod_vasync.pipeline({
    'funcs': [
	/* Set up servers */
	function (_, callback) {
		log.info('serv1: listen start');
		serv1.listen(8123, callback);
	},
	function (_, callback) {
		log.info('serv2: listen start');
		serv2.listen(8125, callback);
	},

	/* Run the test cases in sequence. */
	function (_, callback) {
		var funcs = [];
		for (var k in test_cases)
			funcs.push(runTestCase.bind(null, k, test_cases[k]));

		mod_vasync.pipeline({ 'funcs': funcs }, callback);
	},

	/* Clean up */
	function (_, callback) {
		serv1.close();
		serv2.close();
		callback();
	}
    ]
}, function (err) {
	if (err) {
		log.fatal('TEST FAILED: %s', err);
		process.exit(1);
	}

	log.info('TEST PASSED');
});

function handleRequest(server, request, response, next)
{
	var delay, source;

	request.log.debug('server request: ' + request.url);
	delay = request.url == '/slow' ? srvLongDelay : srvRequestDelay;

	srvConcurr++;
	if (srvConcurr > srvConcurrMaxSeen)
		srvConcurrMaxSeen = srvConcurr;

	if (request.url == '/large') {
		/*
		 * This is totally ad-hoc code for this test case.  See above
		 * for what we're trying to test.
		 */
		var max_throttled, max_ms;
		var cur_throttled;

		source = new DataSource(bigRequestSize);
		source.on('throttled', function (count) {
			var m = process.memoryUsage();
			log.debug('throttled after %d bytes', count, m);
			cur_throttled = count;

			/*
			 * This is the crux of the test: we should never end up
			 * buffering nearly as much data as the payload.
			 */
			mod_assert.ok(m['heapTotal'] < bigRequestSize / 2);
		});
		source.on('unthrottled', function (d) {
			var ms = Math.floor((d[1] + d[0] * 1000000000) / 1e6);
			if (max_throttled === undefined ||
			    ms > max_ms) {
				max_throttled = cur_throttled;
				max_ms = ms;
			}
			cur_throttled = undefined;
			log.debug('unthrottled after %d ms', ms);
		});

		source.on('end', function () {
			--srvConcurr;

			/*
			 * Check that we got throttled around the
			 * perRequestBuffer, for almost "bigRequestDelay" ms.
			 */
			log.info('max throttle', max_throttled, max_ms);
			mod_assert.ok(max_throttled !== undefined);
			mod_assert.ok(max_throttled > 0.5 * perRequestBuffer &&
			    max_throttled < 1.5 * perRequestBuffer);
			mod_assert.ok(max_ms > 0.5 * srvLongDelay &&
			    max_ms < 1.5 * srvLongDelay);
			next();
		});

		response.writeHead(200, { 'content-length': bigRequestSize });
		source.pipe(response);

		return;
	}

	setTimeout(function () {
		--srvConcurr;
		response.send(server.address().port + request.url);
		next();
	}, delay);
}

/*
 * Runs a single test case "t" called "name".  See the global definition of
 * test_cases above.
 */
function runTestCase(name, t, _, callback)
{
	var stream, buf, sz;

	log.info('test "%s": start', name);

	if (t['pre'])
		t['pre']();

	stream = new CatStreams({
	    'log': log,
	    'perRequestBuffer': perRequestBuffer,
	    'maxConcurrency': concurrencyLimit
	});

	t['resources'].forEach(function (rq) {
		stream.cat(function (options) {
			if (!clients[rq['server']]) {
				clients[rq['server']] =
				    mod_restify.createClient({
					'agent': false,
					'url': rq['server'],
					'connectTimeout': 500,
					'retry': {
					    'retries': 1,
					    'minTimeout': 500,
					    'maxTimeout': 501
					},
					'log': log.child({
					    'level': 'info',
					    'component': 'client-' +
					        rq['server']
					})
				    });
			}

			var client = clients[rq['server']];
			return (new HttpStream({
			    'client': client,
			    'path': rq['path'],
			    'log': log,
			    'highWaterMark': options['highWaterMark']
			}));
		});
	});
	stream.cat(null);

	if (t['expected'])
		buf = new Buffer(0);
	sz = 0;
	stream.on('data', function (chunk) {
		if (buf)
			buf += chunk;
		sz += chunk.length;
	});

	stream.on('error', function (err) {
		if (t['error'] && t['error'].test(err.message)) {
			log.info(err, 'test "%s": found expected error', name);
			if (t['post']) {
				log.debug('test "%s": post-check', name);
				t['post']();
			}
			callback();
			return;
		}

		if (t['error'])
			log.error(err, 'test "%s": found error, but not ' +
			    'the expected one (which was /%s/)', name,
			    t['error'].source);
		else
			log.error(err, 'test "%s": unexpected error', name);

		callback(new VError(err, 'unexpected error'));
	});

	stream.on('end', function () {
		if (t['error']) {
			callback(new VError('test "%s": expected error, ' +
			    'but got none', name));
			return;
		}

		if (t['expected']) {
			mod_assert.equal(buf.toString('utf8'), t['expected']);
			log.info('test "%s": content matched (%d bytes)',
			    name, buf.length);
		} else {
			mod_assert.equal(sz, t['expected_size']);
			log.info('test "%s": got expected size (%d bytes)',
			    name, sz);
		}

		if (t['post']) {
			log.debug('test "%s": post-check', name);
			t['post']();
		}

		callback();
	});
}

function DataSource(size)
{
	this.ds_emitted = 0;
	this.ds_size = size;
	this.ds_throttled = null;
	mod_stream.Readable.call(this, { 'highWaterMark': 1024 * 1024 });
}

mod_util.inherits(DataSource, mod_stream.Readable);

DataSource.prototype._read = function (sz)
{
	var count, b, i;

	if (this.ds_throttled !== null) {
		this.emit('unthrottled', process.hrtime(this.ds_throttled));
		this.ds_throttled = null;
	}

	count = Math.min(this.ds_size - this.ds_emitted, sz);
	if (count === 0) {
		this.push(null);
		return;
	}

	this.ds_emitted += count;
	b = new Buffer(count);
	for (i = 0; i < count; i++)
		b[i] = 'a';
	if (!this.push(b)) {
		this.emit('throttled', this.ds_emitted);
		this.ds_throttled = process.hrtime();
	}
};

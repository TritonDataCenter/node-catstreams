#!/usr/bin/env node

/*
 * stresser.js: stresses the CatStreams stream's abort() method using an HTTP
 * Client.  You specify URLs on the command line to fetch.  The stresser
 * instantiates a CatStreams that round-robins among the URLs.
 *
 * You can send SIGUSR2 to call abort() on the current CatStreams.  The program
 * will stop doing anything until you send SIGUSR2 again, at which point it will
 * start again.  The intention is to check for file descriptor leaks (using
 * something like pfiles(1)) and memory leaks while the program is quiesced.
 */

var mod_assert = require('assert');
var mod_bunyan = require('bunyan');
var mod_cmdutil = require('cmdutil');
var mod_restify = require('restify');
var mod_url = require('url');

var CatStreams = require('../lib/catstreams');
var HttpStream = require('httpstream');

/* internal states */
var ST_S_QUIESCED = 'quiesced';
var ST_S_RUNNING = 'running';

var stUrls;		/* list of URLs to fetch (from command-line) */
var stClients;		/* list of clients, one for each URL */
var stState;		/* one of ST_S_* constants above */
var stLog;		/* bunyan logger */
var stCatStreams;	/* CatStreams instance */
var stLastCatStreams;	/* last CatStreams instance */
var stCount;		/* count of times we've started */
var stTo;		/* timeout handle */

var stInfoSig = 'SIGUSR2';

function main()
{
	mod_cmdutil.configure({
	    'usageMessage': 'Stress-tests catstreams by fetching URLs.  Use ' +
	        'SIGUSR2 to abort the stream and\npause to check for ' +
		'leaks.',
	    'synopses': [ 'URL...' ]
	});

	if (process.argv.length == 2)
		mod_cmdutil.usage('expected at least one URL');

	stLog = new mod_bunyan({
	    'name': 'stresser',
	    'level': 'warn'
	});

	stCount = 0;
	stState = ST_S_QUIESCED;
	stUrls = process.argv.slice(2).map(function (cli_url, i) {
		var parsed;

		parsed = mod_url.parse(cli_url);
		if (parsed.protocol != 'http:' &&
		    parsed.protocol != 'https:') {
			mod_cmdutil.usage('url %d: expected http[s]: "%s"',
			    i + 1, cli_url);
		}

		return ({
		    'raw': cli_url,
		    'parsed': parsed
		});
	});
	stClients = stUrls.map(function (urlpair, i) {
		return (mod_restify.createClient({
		    'agent': false,
		    'log': stLog.child({
		        'urli': i,
			'url': urlpair['raw']
		    }),
		    'url': mod_url.format({
		        'protocol': 'http',
			'host': urlpair['parsed']['host']
		    })
		}));
	});

	process.on(stInfoSig, onSignal);
	log('process ' + process.pid);
	stresser();
}

function onSignal()
{
	if (stState == ST_S_QUIESCED) {
		log('got ' + stInfoSig + ': starting');
		console.error(process.memoryUsage());
		if (stTo !== undefined) {
			clearTimeout(stTo);
			stTo = undefined;
		}
		stresser();
	} else {
		log('got ' + stInfoSig + ': quiesced');
		mod_assert.equal(stState, ST_S_RUNNING);
		quiesce();
		log('use ' + stInfoSig + ' again to start again');
		/*
		 * This timeout is janky, but it's an easy way to keep Node
		 * running while we wait for a signal.
		 */
		(function () {
			stTo = setTimeout(arguments.callee, 5000);
		})();
	}
}

function stresser()
{
	var stream;

	mod_assert.equal(stState, ST_S_QUIESCED);
	mod_assert.ok(stCatStreams === undefined);

	log('starting stream');
	stState = ST_S_RUNNING;
	stCount++;
	stCatStreams = stream = new CatStreams({
	    'log': stLog.child({ 'component': 'CatStreams', 'count': stCount }),
	    'perRequestBuffer': 10 * 1024 * 1024,
	    'maxConcurrency': 5
	});

	stUrls.forEach(function (urlpair, i) {
		stCatStreams.cat(function (options) {
			return (new HttpStream({
			    'client': stClients[i],
			    'path': urlpair['parsed']['path'],
			    'log': stLog.child({ 'component': 'HttpStream' }),
			    'highWaterMark': options['highWaterMark']
			}));
		});
	});

	stCatStreams.cat(null);
	stCatStreams.stSum = 0;
	stCatStreams.on('data', function (c) {
		stream.stSum += c.length;
	});
	stCatStreams.on('end', function () {
		if (stream == stCatStreams) {
			if (stState == ST_S_RUNNING) {
				log('note: current stream finished, ' +
				    'starting again (' + stCatStreams.stSum +
				    ' bytes)');
				quiesce();
				stresser();
			} else {
				mod_assert.equal(stState, ST_S_QUIESCED);
				log('note: current stream finished, ' +
				    'quiesced (' + stCatStreams.stSum +
				    ' bytes)');
			}
		} else {
			log('note: a previous stream finished');
		}
	});
}

function quiesce()
{
	mod_assert.equal(stState, ST_S_RUNNING);
	stLastCatStreams = stCatStreams;
	stCatStreams.abort();
	stCatStreams = undefined;
	stState = ST_S_QUIESCED;
}

function log(str)
{
	console.log('%s: %s', new Date().toISOString(), str);
}

main();

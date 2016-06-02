# catstreams: Concatenate data from multiple streams fetched concurrently

catstreams provides a Readable stream interface that concatenates the results of
N other streams.


## Example

    $ cat examples/catstreams.js
    /*
     * examples/catstreams.js: basic CatStreams example
     */

    var mod_restify = require('restify');
    var mod_bunyan = require('bunyan');
    var HttpStream = require('httpstream');
    var CatStreams = require('../lib/catstreams');

    var log = new mod_bunyan({
        'name': 'example',
        'level': 'warn',
        'serializers': mod_restify.bunyan.serializers
    });

    var client = mod_restify.createClient({
        'log': log,
        'url': 'https://us-east.manta.joyent.com'
    });

    var stream = new CatStreams({
        'log': log,
        'perRequestBuffer': 10 * 1024 * 1024,
        'maxConcurrency': 2
    });

    stream.cat(function (options) {
    	return (new HttpStream({
    	    'client': client,
    	    'path': '/manta/public/sdks/node-manta.tar.gz',
    	    'log': log,
    	    'highWaterMark': options['highWaterMark']
    	}));
    });

    stream.cat(function (options) {
    	return (new HttpStream({
    	    'client': client,
    	    'path': '/manta/public/sdks/node-manta.tar.gz',
    	    'log': log,
    	    'highWaterMark': options['highWaterMark']
    	}));
    });

    stream.cat(null);

    var sum = 0;
    console.log('fetching ... ');
    stream.on('data', function (c) { sum += c.length; });
    stream.on('end', function () {
    	console.log('fetched %d bytes', sum);
    	client.close();
    });

    $ mls -l /manta/public/sdks/node-manta.tar.gz
    -rwxr-xr-x 1 manta       2697998 Jul 22 15:52 node-manta.tar.gz

    $ node examples/catstream.js
    fetching ...
    fetched 5395996 bytes


## Contributions

Pull requests should be "make prepush" clean.

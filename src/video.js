const express = require('express')
const helperFuncs = require('./helperFuncs')
const FFMPEG = require('./ffmpeg')
const FFMPEG_TEXT = require('./ffmpegText')
const PlexTranscoder = require('./plexTranscoder')
const fs = require('fs')

module.exports = { router: video }

function video(db) {
    var router = express.Router()

    router.get('/setup', (req, res) => {
        let ffmpegSettings = db['ffmpeg-settings'].find()[0]
        // Check if ffmpeg path is valid
        if (!fs.existsSync(ffmpegSettings.ffmpegPath)) {
            res.status(500).send("FFMPEG path is invalid. The file (executable) doesn't exist.")
            console.error("The FFMPEG Path is invalid. Please check your configuration.")
            return
        }

        console.log(`\r\nStream starting. Channel: 1 (PseudoTV)`)

        let ffmpeg = new FFMPEG_TEXT(ffmpegSettings, 'PseudoTV (No Channels Configured)', 'Configure your channels using the PseudoTV Web UI')

        ffmpeg.on('data', (data) => { res.write(data) })

        ffmpeg.on('error', (err) => {
            console.error("FFMPEG ERROR", err)
            res.status(500).send("FFMPEG ERROR")
            return
        })
        ffmpeg.on('close', () => {
            res.end()
        })

        res.on('close', () => { // on HTTP close, kill ffmpeg
            ffmpeg.kill()
            console.log(`\r\nStream ended. Channel: 1 (PseudoTV)`)
        })
    })
    // Continuously stream video to client. Leverage ffmpeg concat for piecing together videos
    router.get('/video', (req, res) => {
        // Check if channel queried is valid
        if (typeof req.query.channel === 'undefined') {
            res.status(500).send("No Channel Specified")
            return
        }
        let channel = db['channels'].find({ number: parseInt(req.query.channel, 10) })
        if (channel.length === 0) {
            res.status(500).send("Channel doesn't exist")
            return
        }
        channel = channel[0]

        let ffmpegSettings = db['ffmpeg-settings'].find()[0]

        // Check if ffmpeg path is valid
        if (!fs.existsSync(ffmpegSettings.ffmpegPath)) {
            res.status(500).send("FFMPEG path is invalid. The file (executable) doesn't exist.")
            console.error("The FFMPEG Path is invalid. Please check your configuration.")
            return
        }

        res.writeHead(200, {
            'Content-Type': 'video/mp2t'
        })

        console.log(`\r\nStream starting. Channel: ${channel.number} (${channel.name})`)

        let ffmpeg = new FFMPEG(ffmpegSettings, channel);  // Set the transcoder options

        ffmpeg.on('data', (data) => { res.write(data) })

        ffmpeg.on('error', (err) => {
            console.error("FFMPEG ERROR", err);
            //status was already sent
            res.end();
            return;
        })

        ffmpeg.on('close', () => {
            res.end();
        })
        
        res.on('close', () => { // on HTTP close, kill ffmpeg
            console.log(`\r\nStream ended. Channel: ${channel.number} (${channel.name})`);
            ffmpeg.kill();
        })

        ffmpeg.on('end', () => {
            console.log("Recieved end of stream when playing a continuous playlist. This should never happen!");
            console.log("This either means ffmpeg could not open any valid streams, or you've watched countless hours of television without changing channels. If it is the latter I salute you.")
        })

        let channelNum = parseInt(req.query.channel, 10)
        ffmpeg.spawnConcat(`http://localhost:${process.env.PORT}/playlist?channel=${channelNum}`);
    })
    // Stream individual video to ffmpeg concat above. This is used by the server, NOT the client
    router.get('/stream', (req, res) => {
        // Check if channel queried is valid
        if (typeof req.query.channel === 'undefined') {
            res.status(500).send("No Channel Specified")
            return
        }
        let channel = db['channels'].find({ number: parseInt(req.query.channel, 10) })
        if (channel.length === 0) {
            res.status(500).send("Channel doesn't exist")
            return
        }
        channel = channel[0]

        let ffmpegSettings = db['ffmpeg-settings'].find()[0]
        let plexSettings = db['plex-settings'].find()[0]

        // Check if ffmpeg path is valid
        if (!fs.existsSync(ffmpegSettings.ffmpegPath)) {
            res.status(500).send("FFMPEG path is invalid. The file (executable) doesn't exist.")
            console.error("The FFMPEG Path is invalid. Please check your configuration.")
            return
        }

        res.writeHead(200, {
            'Content-Type': 'video/mp2t'
        })

        // Get video lineup (array of video urls with calculated start times and durations.)
        let prog = helperFuncs.getCurrentProgramAndTimeElapsed(Date.now(), channel)
        let lineup = helperFuncs.createLineup(prog)
        let lineupItem = lineup.shift()


        let streamDuration = lineupItem.streamDuration / 1000;

        // Only episode in this lineup, or item is a commercial, let stream end naturally
        if (lineup.length === 0 || lineupItem.type === 'commercial' || lineup.length === 1 && lineup[0].type === 'commercial')
            streamDuration = undefined

        let enableChannelIcon = helperFuncs.isChannelIconEnabled( ffmpegSettings, channel, lineupItem.type);
        let deinterlace = ffmpegSettings.enableFFMPEGTranscoding; //for now it will always deinterlace when transcoding is enabled but this is sub-optimal

        let plexTranscoder = new PlexTranscoder(plexSettings, lineupItem);
        let ffmpeg = new FFMPEG(ffmpegSettings, channel);  // Set the transcoder options

        var ffmpeg1Ended = false;
        ffmpeg.on('data', (data) => { res.write(data) })

        ffmpeg.on('error', (err) => {
            if (ffmpeg1Ended) {
                return;
            }
            ffmpeg1Ended = true;
            plexTranscoder.stopUpdatingPlex();
            if (typeof(this.backup) !== 'undefined') {
                let ffmpeg2 = new FFMPEG(ffmpegSettings, channel);  // Set the transcoder options
                ffmpeg2.spawnError('Source error', `ffmpeg returned code ${err.code}`, this.backup.stream.streamStats, this.backup.enableChannelIcon, this.backup.type); // Spawn the ffmpeg process, fire this bitch up
                ffmpeg2.on('data', (data) => {
                    try {
                        res.write(data)
                    } catch (err) {
                        console.log("err="+err);
                    }
                } );
                ffmpeg2.on('error', (err) => { res.end() } );
                ffmpeg2.on('close', () => { res.send() } );
                ffmpeg2.on('end', () => { res.end() } );
                res.on('close', () => {
                    ffmpeg2.kill();
                });
            } else {
                res.end()
            }
        })

        ffmpeg.on('close', () => {
            if (ffmpeg1Ended) {
                return;
            }
            plexTranscoder.stopUpdatingPlex();
            res.end();
        })

        ffmpeg.on('end', () => { // On finish transcode - END of program or commercial...
            if (ffmpeg1Ended) {
                return;
            }
            plexTranscoder.stopUpdatingPlex();
            res.end()
        })
        
        res.on('close', () => { // on HTTP close, kill ffmpeg
            plexTranscoder.stopUpdatingPlex();
            ffmpeg.kill();
        })

        plexTranscoder.getStream(deinterlace).then(stream => {

            let streamStart = (stream.directPlay) ? plexTranscoder.currTimeS : undefined;

            let streamStats = stream.streamStats;
            streamStats.duration = lineupItem.streamDuration;

            this.backup = {
                stream: stream,
                streamStart: streamStart,
                enableChannelIcon: enableChannelIcon,
                type: lineupItem.type
            };

            ffmpeg.spawnStream(stream.streamUrl, stream.streamStats, streamStart, streamDuration, enableChannelIcon, lineupItem.type); // Spawn the ffmpeg process, fire this bitch up
            plexTranscoder.startUpdatingPlex();
        });
    })
    router.get('/playlist', (req, res) => {
        res.type('text')

        // Check if channel queried is valid
        if (typeof req.query.channel === 'undefined') {
            res.status(500).send("No Channel Specified")
            return
        }

        let channelNum = parseInt(req.query.channel, 10)
        let channel = db['channels'].find({ number: channelNum })
        if (channel.length === 0) {
            res.status(500).send("Channel doesn't exist")
            return
        }

        // Maximum number of streams to concatinate beyond channel starting
        // If someone passes this number then they probably watch too much television
        let maxStreamsToPlayInARow = 100;

        var data = "ffconcat version 1.0\n"

        for (var i = 0; i < maxStreamsToPlayInARow; i++)
            data += `file 'http://localhost:${process.env.PORT}/stream?channel=${channelNum}'\n`

        res.send(data)
    })
    return router
}

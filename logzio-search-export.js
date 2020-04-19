#!/usr/bin/env node -r top-level-await

const program = require('commander');
const axios = require('axios');
const fs = require('fs');
const getStdin = require('get-stdin');
const cliProgress = require('cli-progress');
const colors = require('colors');
const csvWriteStream = require('csv-write-stream');
const exitHook = require('exit-hook');
const _ = require('lodash');

/*
 * COMMAND LINE SETUP
 */

const collect = (value, previous) => previous.concat([value]);

program
  .version('1.0.0')
  .option('-t, --api-token <api-token>', 'Logz.io API token [envvar: LOGZIO_API_TOKEN]')
  .option('-r, --region <region>', 'Logz.io region for account, defaults to eu [envvar: LOGZIO_API_REGION]')
  .option('-s, --search <search>', 'A simple search term. For more complex queries pipe in via stdin.')
  .option('-e, --extract <extract>', 'log entry fields to extract in output (can be provided multiple times) (default: all fields are returned)', collect, [])
  .option('--start <start-time>', 'A Logz,io compatible query start time', 'now-5m')
  .option('--end <end-time>', 'A Logz.io compatible end time', 'now')
  .option('-f, --format <format>', 'output format [json, csv]', 'json')
  .option('-o, --output <output>', 'output file to write results to (default: stdout)')
  .option('-v, --verbose', 'print verbose output')
  .parse(process.argv);

const progress = new cliProgress.SingleBar({
  format: 'Logz.io Search Export |' + colors.cyan('{bar}') + '| {percentage}% || {value}/{total} || {duration_formatted} || ETA {eta_formatted} || Speed: {speed} logs/s',
  barCompleteChar: '\u2588',
  barIncompleteChar: '\u2591',
  hideCursor: true,
  fps: 4,
  etaBuffer: 100000
});
exitHook(() => progress.stop());

const logzioToken = program.apiToken || process.env['LOGZIO_API_TOKEN'];
if (!logzioToken) {
  error(`Logz.io API token not provided, please provide one via cli flag --api-token or envvar LOGZIO_API_TOKEN`);
}
const region = program.region || process.env['LOGZIO_API_REGION'] || 'eu';
const baseURL = region === 'us' ? 'https://api.logz.io' : `https://api-${region}.logz.io`;
const logzio = axios.create({
  baseURL,
  timeout: 5000,
  headers: {
    'content-type': 'application/json',
    'accept': 'application/json',
    'accept-encoding': 'gzip, deflate',
    'x-api-token': logzioToken
  }
});

let search = {
  "sort": [{"@timestamp": {"order": "asc"}}],
  "size": 1000
}
if (program.search) {
  log(`Searching: ${program.search} in time range: ${program.start} => ${program.end}`)
  // Simple search mode
  search = {
    ...search,
    "query": {
      "bool": {
        "must": [{"query_string": {"query": program.search}},
          {"range": {"@timestamp": {"gte": program.start, "lte": program.end}}}]
      }
    }
  }
} else {
  const stdin = await getStdin();
  try {
    const query = JSON.parse(stdin);
    log(`Search query provided:\n${JSON.stringify(query, null, 2)}`);
    search = { ...search, query };
  } catch (e) {
    console.error(program.helpInformation());
    error(`Can't parse JSON query from stdin. Either provide a query or use --search flag`);
  }
}

if (!_.isEmpty(program.extract)) {
  search = {
    ...search,
    "_source": {
      "includes": program.extract
    },
  }
}

function getNextSearchResults(search, scrollId) {
  const response = !!scrollId ?
    logzio.post('/v1/scroll', {scroll_id: scrollId}) :
    logzio.post('/v1/scroll', search);
  return response
    .then(resp => resp.data)
    .catch(err => {
      console.error(err.response.data);
      error(`Unexpected status code received: ${err.response.status}`);
    });
}

// Set up output
const outputStream = createOutputStream();
exitHook(() => outputStream.end());
let csvWriter;
exitHook(() => csvWriter && csvWriter.end());

let offset = 0;
let scrollId;
let batchSize;
const startTime = process.hrtime();
do {
  const response = await getNextSearchResults(search, scrollId);
  const results = JSON.parse(response.hits);
  if (offset === 0) {
    // First request
    scrollId = response.scrollId;
    progress.start(results.total, 0);
  }

  batchSize = results.hits.length;

  for (let hit of results.hits) {
    processHit(hit);
    offset += 1;
  }

  const endTime = process.hrtime(startTime);
  const speed = endTime[0] > 0 ? Math.floor(offset / endTime[0]) : offset;
  progress.update(offset, { speed });
} while (batchSize !== 0);

finishStream()
progress.stop();
console.error(`${colors.green('SUCCESS')}: Exported ${offset} log entries`);

// OUTPUT functions

function createOutputStream() {
  log(`Format configured: ${program.format}`)
  if (program.output) {
    log(`Output set to: ${program.output}`);
    if (fs.existsSync(program.output)) {
      if (fs.lstatSync(program.output).isFile()) {
        error(`File exists: ${program.output}`)
      } else {
        error(`Directory not a valid output, needs to be a file: ${program.output}`)
      }
    }
    return fs.createWriteStream(program.output);
  } else {
    log('Outputting to stdout');
    return process.stdout;
  }
}

function finishStream() {
  if (program.format === 'json') {
    if (offset === 0) {
      outputStream.write('[');
    }
    outputStream.write(']');
  }
  if (program.format === 'csv') {
    csvWriter.end();
  }
  if (program.output) {
    outputStream.end();
  }
}

function processHit(hit) {
  // Drop useless fields
  const sanitisedHit = _.omit(hit, 'sort', '_score');
  if (program.format === 'json') {
    return writeJson(sanitisedHit);
  }
  if (program.format === 'csv') {
    return writeCsv(sanitisedHit)
  }
  error(`Unrecognized format: ${program.output}`);
}

function writeJson(hit) {
  outputStream.write(offset === 0 ? '[' : ',');
  outputStream.write('\n');
  outputStream.write(JSON.stringify(hit));
}

function writeCsv(hit) {
  if (!csvWriter) {
    csvWriter = csvWriteStream();
    csvWriter.pipe(outputStream);
  }
  csvWriter.write(hit['_source']);
}

// Helpers

function log() {
  if (program.verbose) console.error.apply(this, arguments);
}

function error(message) {
  progress.stop();
  console.error(colors.red(message));
  process.exit(1);
}

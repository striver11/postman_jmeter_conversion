#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const yargs = require('yargs');
const TemplateJmeter = require('../lib/template-jmeter');
const RequestObject = require('../lib/request-object');

const argv = yargs
  .usage('Usage: $0 -p [Postman Collection] -j [JMeter Test Plan] -e [Postman Environment]')
  .option('p', {
    alias: 'postman',
    describe: 'Path to the Postman collection JSON file',
    type: 'string',
    demandOption: true
  })
  .option('j', {
    alias: 'jmeter',
    describe: 'Path to the output JMeter test plan XML file',
    type: 'string',
    demandOption: true
  })
  .option('e', {
    alias: 'environment',
    describe: 'Path to the Postman environment JSON file',
    type: 'string',
    demandOption: false
  })
  .help()
  .argv;

const postmanCollectionPath = path.resolve(argv.p);
const jmeterTestPlanPath = path.resolve(argv.j);
const postmanEnvironmentPath = argv.e ? path.resolve(argv.e) : null;

if (!fs.existsSync(postmanCollectionPath)) {
  console.error(`Postman collection file not found: ${postmanCollectionPath}`);
  process.exit(1);
}

const postmanCollection = JSON.parse(fs.readFileSync(postmanCollectionPath, 'utf8'));
const requests = postmanCollection.item.map(item => {
  const { name, request } = item;
  const { url, method, body, header } = request;
  const bodyData = body ? body.raw : '';
  const headers = header ? header.map(h => ({ headerName: h.key, headerValue: h.value })) : [];
  return new RequestObject(name, url.protocol, url.host.join('.'), url.port, url.path.join('/'), method, bodyData, headers);
});

const templateJmeter = new TemplateJmeter();
const jmeterXML = templateJmeter.engineJmeterProject(requests, {});

fs.writeFileSync(jmeterTestPlanPath, jmeterXML, 'utf8');
console.log(`JMeter test plan generated at: ${jmeterTestPlanPath}`);

'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var color = require('colorful');
var mkdirp = require('mkdirp');
var extend = require('extend');
var spmrc = require('spmrc');
var log = require('spm-log');
var gulp = require('gulp');
var gunzip = require('gulp-gunzip');
var untar = require('gulp-untar2');
var pipe = require('multipipe');
var format = require('util').format;
var util = require('./util');
var info = require('./info');
var request = require('./request');
var debug = require('debug')('spm-client:install');

var homedir = spmrc.get('user.home');
var defaults = {
  base: process.cwd(),
  destination: 'spm_modules',
  cache: path.join(homedir, '.spm', 'cache')
};

/*
  install(args, config)

  args
  - name
  - cwd
  - destination
  - force
  - save
  - saveDev
  config
*/

module.exports = function* install(args, config) {
  args = extend({}, defaults, args, config || {}, require('./config')());
  args.destination = path.join(args.base, args.destination);
  args.downloadlist = {};

  var packages;

  // spm install id@version
  if (args.name) {
    packages = [args.name];
  }

  // spm install
  else {
    delete args.save;
    delete args.saveDev;
    var pkgPath = path.join(args.base, 'package.json');
    packages = parseDependencies(pkgPath, true);
  }

  // no package to be installed
  if (!packages.length) return;

  debug('install packages $s', packages.join(', '));
  yield* packages.map(function(id) {
    return spmInstall(id, args, true);
  });
};

/* Install a package.
 *
 * The process of the installation:
 *
 *  1. Find and download the package from yuan or cache
 *  2. Copy the files to `sea-modules/{name}/{version}/{file}
 */
function* spmInstall(id, args, saveDeps) {
  var idObj = util.resolveid(id);

  // The package has downloaded in dest
  // always false when version is not empty
  if (existInDest(idObj, args)) return;

  // The package has been in downloadlist
  var pkgId = idObj.name + '@' + (idObj.version || 'stable');
  if (pkgId in args.downloadlist) {
    debug('package %s has been in downloadlist', pkgId);
    return;
  }

  log.info('install', color.magenta(pkgId));
  debug('start install package %s', pkgId);

  var pinfo = yield* info(idObj, args);
  pkgId = pinfo.name + '@' + pinfo.version;
  args.downloadlist[pkgId] = pinfo;
  debug('get package info from %s: %j', args.registry, pinfo);

  // save dependencies to package.json
  if ((args.save || args.saveDev) && saveDeps) {
    save(pinfo, args);
  }

  var dest = path.join(args.destination, pinfo.name, pinfo.version);
  var filename = pinfo.filename || pinfo.name + '-' + pinfo.version + '.tar.gz';
  var fileInCache = path.join(args.cache, filename);
  var fileInRemote = format('%s/repository/%s/%s/%s',
    args.registry, pinfo.name, pinfo.version, filename);

  // The package has downloaded
  if (existInDest(pinfo, args)) return;

  // install from cache when file is not changed
  if (!args.force && fs.existsSync(fileInCache) && md5file(fileInCache) === pinfo.md5) {
    yield extract(fileInCache, dest);
    return;
  }

  // install from registry
  yield download(fileInRemote, fileInCache);
  yield extract(fileInCache, dest);

  var relativePath = path.relative(process.cwd(), dest);
  log.info('installed', color.green(relativePath));
  debug('end install package %s', pkgId);

  var packages = parseDependencies(pinfo);
  if (!packages.length) return;

  log.info('depends', packages.join(', '));
  debug('install packages(%s) of dependencies %s', pkgId, packages.join(', '));
  yield* packages.map(function(id) {
    return spmInstall(id, args);
  });
}

function existInDest(idObj, args) {
  var pkgId = format('%s/%s', idObj.name, idObj.version);
  var dest = path.join(args.destination, idObj.name, idObj.version);
  if (!args.force && fs.existsSync(dest)) {
    log.info('found', pkgId);
    debug('package %s found in %s', pkgId, dest);
    if (!args.downloadlist[pkgId]) args.downloadlist[pkgId] = idObj;
    return true;
  }
}

function download(urlpath, dest) {
  return function(callback) {
    log.info('download', urlpath);
    debug('download from %s to %s', urlpath, dest);
    mkdirp(path.dirname(dest));

    request(urlpath)
    .once('error', callback)
    .once('end', callback)
    .once('close', callback)
    .pipe(fs.createWriteStream(dest));
  };
}

function extract(src, dest) {
  return function(callback) {
    log.info('extract', src);
    debug('extract package from %s', src);
    pipe(
      gulp.src(src),
      gunzip(),
      untar(),
      gulp.dest(dest)
    )
    .once('error', callback)
    .once('end', callback)
    .resume();
  };
}

function parseDependencies(pkg, includeDev) {
  if (typeof pkg === 'string') {
    pkg = readJSON(pkg);
  }

  var spm = pkg.spm || {};
  var deps = extend({},
    includeDev ? spm.engines : {},
    includeDev ? spm.devDependencies : {},
    spm.dependencies);

  return Object.keys(deps).map(function(key) {
    return key + '@' + deps[key];
  });
}

function save(idObj, args) {
  var pkgPath = path.join(args.base, 'package.json');
  var pkg = readJSON(pkgPath);
  var key = args.save ? 'dependencies' : 'devDependencies';

  log.info(key + ' deps saved ', key, idObj.name + '@' + idObj.version);
  pkg.spm = pkg.spm || {};
  pkg.spm[key] = pkg.spm[key] || {};
  pkg.spm[key][idObj.name] = idObj.version;

  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
}

function md5file(fpath) {
  var md5 = crypto.createHash('md5');
  return md5.update(fs.readFileSync(fpath)).digest('hex');
}

function readJSON(filepath) {
  JSON.parse(fs.readFileSync(filepath));
}
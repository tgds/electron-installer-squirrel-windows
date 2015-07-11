process.env.DEBUG = '*';

var fs = require('fs');
var path = require('path');
var temp = require('temp');
var async = require('async');
var format = require('util').format;
var debug = require('debug')('electron-installer-squirrel-windows:test');

var createInstaller = require('../');

var app = {
  path: require('electron-installer-fixture-windows')
};
const UPDATE_EXE = path.join(app.path, 'Update.exe');

var createsPaths = [];
describe('electron-installer-squirrel-windows', function() {
  before(function(done) {
    temp.mkdir('electron-installer-squirrel-windows', function(err, out) {
      if (err) return done(err);

      app.out = out;
      fs.exists(UPDATE_EXE, function(exists) {
        if (!exists) return done();
        fs.unlink(UPDATE_EXE, done);
      });
    });
  });
  it('creates a nuget package and installer', function(done) {
    debug('creating installer...');
    createInstaller(app, function(err) {
      if (err) return done(err);

      setTimeout(function() {
        createsPaths = [
          path.join(app.out, 'myapp.0.0.0.nupkg'),
          path.join(app.out, 'MyAppSetup.exe'),
          path.join(app.out, 'RELEASES'),
          path.join(UPDATE_EXE)
        ];
        debug('checking paths were created', JSON.stringify(createsPaths, null, 2));
        async.parallel(createsPaths.map(function(p) {
          return function(cb) {
            fs.exists(p, function(exists) {
              if (!exists) {
                return cb(new Error(format('Expected `%s` to exist!', p)));
              }
              cb();
            });
          };
        }), done);
      }, 20000);
    });
  });
  after(function(done) {
    async.parallel(createsPaths.map(function(p) {
      return function(cb) {
        fs.unlink(p, function() {
          cb();
        });
      };
    }), done);
  });
});

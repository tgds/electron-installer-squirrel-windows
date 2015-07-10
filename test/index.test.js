var fs = require('fs');
var path = require('path');
var temp = require('temp');
var async = require('async');
var assert = require('assert');
var format = require('util').format;

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
    createInstaller(app, function(err) {
      if (err) return done(err);

      createsPaths = [
        path.join(app.out, 'foo-bar-1.0.0-full.nupkg'),
        path.join(app.out, 'FooBarSetup.exe'),
        path.join(UPDATE_EXE)
      ];
      async.parallel(createsPaths.map(function(p) {
        return function(cb) {
          fs.exists(p, function(exists) {
            if (!exists) {
              return cb(new assert.AssertionError(format('Expected `%s` to exist!', p)));
            }
            cb();
          });
        };
      }), done);
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

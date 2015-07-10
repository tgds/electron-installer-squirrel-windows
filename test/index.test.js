var fs = require('fs');
var path = require('path');
var temp = require('temp');
var async = require('async');
var assert = require('assert');
var format = require('util').format;

var createInstaller = require('./');

describe('electron-installer-squirrel-windows', function() {
  var app = {
    path: path.join(__dirname, 'fixtures', 'app', 'resources', 'app', 'package.json')
  };
  before(function(done) {
    temp.mkdir('electron-installer-squirrel-windows', function(err, out) {
      if (err) return done(err);

      app.out = out;
      var updateExePath = path.join(__dirname, 'fixtures', 'app', 'Update.exe');
      fs.exists(updateExePath, function(exists) {
        if (!exists) return done();
        fs.unlink(updateExePath, done);
      });
    });
  });
  it('creates a nuget package and installer', function(done) {
    createInstaller(app, function(err) {
      if (err) return done(err);

      var expectedPaths = [
        path.join(app.out, 'myapp-1.0.0-full.nupkg'),
        path.join(app.out, 'MyAppSetup.exe'),
        path.join(__dirname, 'fixtures', 'app', 'Update.exe')
      ];
      async.parallel(expectedPaths.map(function(p) {
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
});

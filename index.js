var cp = require('child_process');
var fs = require('fs-extra');
var asar = require('asar');
var path = require('path');
var temp = require('temp');
var series = require('async').series;
var format = require('util').format;
var debug = require('debug')('electron-installer-squirrel-windows');
var _template = require('lodash.template');

temp.track();

var Model = require('ampersand-model');

// @todo (imlucas): move this to `ampersand-sync-errback`
var createSyncErrback = function(method, model, options) {
  var fn = options.error;
  options.error = function(resp) {
    if (fn) {
      fn(model, resp, options);
    }
    model.trigger('error', model, resp, options);
  };

  var success = options.success;
  options.success = function(resp) {
    if (!model.set(model.parse(resp, options), options)) return false;
    if (success) {
      success(model, resp, options);
    }
  };
  return function(err, resp) {
    if (err) {
      options.error(err);
    } else {
      options.success(resp);
    }
  };
};

var App = Model.extend({
  props: {
    name: 'string',
    version: 'string',
    description: 'string',
    copyright: 'string',
    // Path to the app.
    path: 'string',
    // Directory to put installers in.
    out: 'string',
    product_name: 'string',
    electron_version: {
      type: 'string',
      default: function() {
        // @todo (imlucas): make a module that just has the latest electron
        // version number, e.g.
        // require('electron-latest-version');
        // -> '0.29.2'
        return '0.29.2';
      }
    },
    authors: 'string',
    owners: 'string',
    title: 'string',
    exe: 'string',
    icon_url: 'string',
    setup_icon: 'string',
    loading_gif: 'string',
    remote_releases: 'string'
  },
  derived: {
    asar: {
      deps: ['resources'],
      fn: function() {
        return path.join(this.resources, 'app.asar');
      }
    },
    resources: {
      deps: ['path'],
      fn: function() {
        return path.join(this.path, 'resources');
      }
    },
    setup_path: {
      deps: ['out', 'product_name'],
      fn: function() {
        return path.join(this.out, format('%sSetup.exe', this.product_name.replace(/ /g, '')));
      }
    }
  },
  parse: function(resp) {
    resp.product_name = resp.product_name || resp.productName || resp.name;
    resp.icon_url = resp.icon_url || resp.iconUrl;

    if (!resp.authors) {
      resp.authors = resp.author ? resp.author.name : '';
    }
    if (!resp.exe) {
      resp.exe = format('%s.exe', resp.name);
    }

    resp.loading_gif = resp.loading_gif || resp.loadingGif;
    if (!resp.loading_gif) {
      resp.loading_gif = path.resolve(__dirname, 'resources', 'install-spinner.gif');
    }

    if (!resp.owners) {
      resp.owners = resp.authors;
    }

    if (!resp.title) {
      resp.title = resp.product_name;
    }

    resp.icon_url = resp.icon_url || resp.iconUrl;
    if (!resp.icon_url) {
      resp.icon_url = 'https://raw.githubusercontent.com/atom/electron/'
        + 'master/atom/browser/resources/win/atom.ico';
    }

    if (!resp.copyright) {
      resp.copyright = format('%s %s', new Date().getFullYear(), resp.owners);
    }

    resp.version = resp.version.replace(/-.*$/, '');
    return resp;
  },
  sync: function(method, model, options) {
    var done = createSyncErrback(method, model, options);
    fs.exists(this.asar, function(exists) {
      if (exists) {
        done(null, JSON.parse(asar.extractFile(this.asar, 'package.json')));
      } else {
        fs.readFile(path.join(this.resources, 'app', 'package.json'), function(err, buf) {
          if (err) return done(err);

          done(null, JSON.parse(buf));
        });
      }
    }.bind(this));
  },
  initialize: function(opts, fn) {
    if (!fn) return;

    this.on('sync', function(model) {
      debug('loaded model', JSON.stringify(model.toJSON(), null, 2));
      fn(null, model);
    });
    this.on('error', function(model, err) {
      debug('error fetching model', err);
      fn(err);
    });
    debug('fetching app model');
    this.fetch();
  }
});

const NUGET_EXE = path.resolve(__dirname, 'vendor', 'nuget.exe');
const SYNC_RELEASES_EXE = path.resolve(__dirname, 'vendor', 'SyncReleases.exe');
const UPDATE_EXE = path.resolve(__dirname, 'vendor', 'Update.exe');

function exec(cmd, args, done) {
  debug('exec `%s` with args `%s`', cmd, args.join(' '));

  fs.exists(cmd, function(exists) {
    if (!exists) {
      return done(new Error('File does not exist at ' + cmd));
    }
    try {
      cp.execFile(cmd, args, function(err, stdout, stderr) {
        if (err) {
          console.error('Error ', err);
        }
        if (stderr) {
          console.error(stderr);
        }
        return done(err);
      });
    } catch (e) {
      console.error('Error executing file:', e);
      done(new Error('Could not execute ' + cmd));
    }
  });
}

function syncReleases(app, done) {
  if (!app.remote_releases) {
    debug('no remote releases.  skipping sync.');
    return process.nextTick(function() {
      return done();
    });
  }

  exec(SYNC_RELEASES_EXE, ['-u', app.remote_releases, '-r', app.out], done);
}

function createTempDirectory(app, done) {
  debug('creating temp directory');
  temp.mkdir('electron-installer-squirrel-windows-', function(err, res) {
    if (err) return done(err);

    app.nuget_out = res;
    app.nuspec_path = path.join(app.nuget_out, format('%s.nuspec', app.name));
    app.nupkg_path = path.join(app.nuget_out, format('%s.%s.nupkg', app.name, app.version));
    done();
  });
}

function createNugetPkg(app, done) {
  debug('generating .nuspec file contents');
  fs.readFile(path.resolve(__dirname, 'template.nuspec'), function(err, buf) {
    if (err) return done(err);

    var template = _template(buf);
    var nuspecContent = template(app.serialize());

    debug('.nuspec file contents:\n', nuspecContent);

    debug('writing nuspec file to `%s`', app.nuspec_path);
    fs.writeFile(app.nuspec_path, nuspecContent, function(err) {
      if (err) return done(err);

      var dest = path.join(app.path, 'Update.exe');
      debug('copying `%s` -> `%s`', UPDATE_EXE, dest);
      fs.copy(UPDATE_EXE, dest, function(err) {
        if (err) return done(err);

        debug('generating `%s`...', app.nuget_out);
        exec(NUGET_EXE, [
          'pack',
          app.nuspec_path,
          '-BasePath',
          app.path,
          '-OutputDirectory',
          app.nuget_out,
          '-NoDefaultExcludes'
        ], done);
      });
    });
  });
}

function createSetupExe(app, done) {
  var cmd = path.resolve(__dirname, 'vendor', 'Update.com');
  var args = [
    '--releasify',
    app.nupkg_path,
    '--releaseDir',
    app.out,
    '--loadingGif',
    app.loading_gif
  ];

  if (app.sign_with_params) {
    args.push.apply(args, ['--signWithParams', app.sign_with_params]);
  } else if (app.cert_path && app.cert_password) {
    args.push.apply(args, [
      '--signWithParams',
      format('/a /f "%s" /p "%s"', path.resolve(app.cert_path), app.cert_password)
    ]);
  }

  if (app.setup_icon) {
    args.push.apply(args, ['--setupIcon', path.resolve(app.setup_icon)]);
  }

  return exec(cmd, args, function(err) {
    if (err) return done(err);

    fs.rename(path.join(app.out, 'Setup.exe'), app.setup_path, function(err) {
      if (err) return done(err);
      done();
    });
  });
}


module.exports = function(opts, done) {
  debug('generating squirrel-windows installer for', JSON.stringify(opts, null, 2));
  var app = new App(opts, function(err) {
    if (err) return done(err);
    series([
      createTempDirectory.bind(null, app),
      createNugetPkg.bind(null, app),
      syncReleases.bind(null, app),
      createSetupExe.bind(null, app)
    ], done);
  });
};

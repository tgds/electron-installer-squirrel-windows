var cp = require('child_process');
var fs = require('fs');
var asar = require('asar');
var path = require('path');
var temp = require('temp');
var series = require('async').series;
var format = require('util').format;
var debug = require('debug')('electron-installer-squirrel-windows');
var _template = require('lodash.template');

temp.track();

var State = require('ampersand-state');

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
    model.trigger('sync', model, resp, options);
  };
  return function(err, resp) {
    if (err) {
      options.error(err);
    } else {
      options.success(resp);
    }
  };
};

var App = State.extend({
  props: {
    name: 'string',
    version: 'string',
    description: 'string',
    copyright: 'string',
    // Path to the app.
    path: 'string',
    // Directory to put installers in.
    out: 'string',
    company_name: 'string',
    product_name: {
      type: 'string',
      default: function() {
        return this.name;
      }
    },
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
    owners: {
      type: 'string',
      default: function() {
        return this.authors;
      }
    },
    title: {
      type: 'string',
      default: function() {
        return this.product_name;
      }
    },
    exe: {
      type: 'string',
      default: function() {
        return format('%s.exe', this.name);
      }
    },
    icon_url: {
      type: 'string',
      default: function() {
        return 'https://raw.githubusercontent.com/atom/electron/'
          + 'master/atom/browser/resources/win/atom.ico';
      }
    },
    setup_icon: 'string',
    loading_gif: {
      type: 'string',
      default: function() {
        return path.resolve(__dirname, 'resources', 'install-spinner.gif');
      }
    },
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
        return path.join(this.out, format('%s Setup.exe', this.product_name));
      }
    }
  },
  parse: function(resp) {
    resp.product_name = resp.product_name || resp.productName;
    resp.icon_url = resp.icon_url || resp.iconUrl;

    if (!resp.authors) {
      resp.authors = resp.author ? resp.author.name : '';
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
        fs.readFile(path.join(this.resources, 'package.json'), function(err, buf) {
          if (err) return done(err);

          done(null, JSON.parse(buf));
        });
      }
    }.bind(this));
  },
  initialize: function(opts, fn) {
    if (!fn) return;

    this.on('sync', function(model) {
      fn(null, model);
    });
    this.on('error', function(model, err) {
      fn(err);
    });
    this.fetch();
  }
});

const NUGET_EXE = path.resolve(__dirname, 'vendor', 'nuget.exe');
const SYNC_RELEASES_EXE = path.resolve(__dirname, 'vendor', 'SyncReleases.exe');
const UPDATE_EXE = path.resolve(__dirname, 'vendor', 'Update.exe');

function exec(cmd, args, done) {
  return cp.execFile(cmd, args, function(error, stdout, stderr) {
    if (stderr) {
      console.error(stderr);
    }
    return done(error);
  });
}

function syncReleases(app, done) {
  if (!app.remote_releases) {
    return process.nextTick(function() {
      return done();
    });
  }

  exec(SYNC_RELEASES_EXE, ['-u', app.remote_releases, '-r', app.out], done);
}

function createTempDirectory(app, done) {
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

      fs.copy(UPDATE_EXE, path.join(app.path, 'Update.exe'), function(err) {
        if (err) return done(err);

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
  var app = new App(opts);
  app.on('sync', function() {
    series([
      createTempDirectory.bind(null, app),
      createNugetPkg.bind(null, app),
      syncReleases.bind(null, app),
      createSetupExe.bind(null, app)
    ], done);
  });
  app.fetch();
};

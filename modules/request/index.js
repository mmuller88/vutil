
const fs = require('fs'), path = require('path'),
      querystring = require('querystring'),
      BusBoy = require('busboy'),
      utils = require('../../utils'),
      allowedOptions = [
        'preambleCRLF','postambleCRLF','timeout',
        'auth','oauth','encoding','gzip'
      ],
      request = require('request').defaults({ json : true });

function parseAFile(raw){
  return raw;
}

function getParsedResponse(opts,res,next){
  var fields = {}, files = {}, errors = {}, busboy = new BusBoy(opts);
  busboy.on('error', function(err) {
    errors.failed = 'Multipart request could not be processed';
  });
  busboy.on('partsLimit', function() {
    errors.partsLimit = 'limits of parts reached.';
  });
  busboy.on('filesLimit', function() {
    errors.filesLimit = 'limits of files reached.';
  });
  busboy.on('fieldsLimit', function() {
    errors.fieldsLimit = 'limits of fields reached';
  });
  busboy.on('field', function(fieldname, val, fieldT, valT) {
    fields[fieldname] = val;
  });
  busboy.on('file', function(fieldname, file, filename, encoding, mimetype) {
    files[filename] = {
      raw : '',
      fieldname: fieldname,
      filename : filename,
      encoding : encoding,
      mimetype : mimetype
    };
    file.on('limit', function() {
      files[filename].error='File size excceeded the limit.';
    });
    file.on('data', function(data) {
      files[filename].raw += data;
    });
    file.on('end', function(data) {
      files[filename].parsed = parseAFile(files[filename].raw);
    });
  });
  busboy.on('finish', function() {
    next({ files : files, fields : fields, errors : errors });
  });
  res.pipe(busboy);
}

var CombinedStream = require('combined-stream'), uuid = require('uuid');

var setHeaders = require('request/lib/multipart').Multipart.prototype.setHeaders;

function handlePartHeader(part,chunked){
  var plk = Object.keys(part), pln = plk.length;
  var that = {
    boundary : uuid(),
    request : {
      getHeader : function(ky){
        for(var z=0;z<pln;z++){
          if(plk[z].toLowerCase()===ky.toLowerCase()){
            return (part[plk[z]]);
          }
        }
        return false;
      },
      hasHeader : function(ky){
        return Boolean(this.getHeader(ky));
      },
      setHeader : function(ky,vl){
        for(var st = true, z=0;z<pln;z++){
          if(plk[z].toLowerCase()===ky.toLowerCase()){
            part[plk[z]] = vl;
            st = false;
            break;
          }
        }
        if(st){
          part[ky] = vl;
        }
      }
    }
  };
  setHeaders.bind(that)(chunked);
  return that.boundary;
}

require('request/lib/multipart').Multipart.prototype.build = function (parts, chunked) {
  var self = this
  var body = chunked ? new CombinedStream() : []

  function add (part,boundary) {
    if (typeof part === 'number') {
      part = part.toString()
    // change part starts
    } else if(typeof part === 'object' && part) {
      if(Array.isArray(part)){
        var prvB = self.boundary;
        self.boundary = boundary;
        part = self.build(part,chunked);
        self.boundary = prvB;
      } else if(part.filePath){
        part = getFile(part,true);
      }
    }
    // change part ends
    return chunked ? body.append(part) : body.push(Buffer.from(part))
  }

  if (self.request.preambleCRLF) {
    add('\r\n')
  }


  parts.forEach(function (part) {
    var defaultBoundary = handlePartHeader(part,chunked);
    var preamble = '--' + self.boundary + '\r\n'
    Object.keys(part).forEach(function (key) {
      if (key === 'body') { return }
      preamble += key + ': ' + part[key] + '\r\n'
    })
    preamble += '\r\n'
    add(preamble)
    add(part.body,defaultBoundary)
    add('\r\n')
  })
  add('--' + self.boundary + '--')

  if (self.request.postambleCRLF) {
    add('\r\n')
  }

  return body
}

const encoders = function(ab){
  try {
    return require(ab).encode();
  } catch(erm) {
    return false;
  }
};

const getFile = function(ab,nostr){
  if(typeof ab === 'string'){
    return nostr ? ab : fs.createReadStream(ab);
  } else if(typeof ab === 'object' && ab){
    if(Array.isArray(ab)){
      return ab;
    } else if(typeof ab.filePath === 'string'){
      var enc = ab.encode;
      var ret = fs.createReadStream(ab.filePath);
      if(typeof enc === 'string'){
        var enc = encoders(enc);
        if(enc){
          ret.pipe(enc);
        }
      }
      return ret;
    }
  } else {
    return false;
  }
};

function func(req,res,next){
  if(!req.body){
    return res.send(400, { message : "Invalid request payload" });
  }
  if(!utils.isStr(req.body.url)){
    return res.send(400, { message : "Parameter `url` was missing in request." });
  }
  if(!utils.isStr(req.body.method)){
    return res.send(400, { message : "Parameter `method` was missing in request." });
  }
  var formData = {}, rs, kl, kn, bd = req.body.formData;
  if(typeof bd === 'object' && bd){
    for(var ky in bd){
      if(ky === 'attachments' && Array.isArray(bd[ky])){
        kn = bd[ky], kl = kn.length;
        for(var z=0;z<kl;z++){
          rs = getFile(kn[z]);
          if(rs) { kn[z] = rs; }
        }
      } else {
        formData[ky] = getFile(bd,true);
      }
    }
  }
  if(req.body.filePath){
    var fl = 'file1';
    if(utils.isStr(req.body.fileKey) && utils.isAlphaNum(req.body.fileKey)){
      fl = req.body.fileKey;
    }
    rs = getFile(req.body);
    if(rs) {
      formData[fl] = rs;
    }
  }
  var toSend = {
    method : req.body.method,
    url: req.body.url,
    headers : req.body.headers || {}
  };
  if(typeof req.body.options === 'object' && req.body.options){
    allowedOptions.forEach(function(op){
      if(req.body.options[op] !== undefined){
        toSend[op] = req.body.options[op];
      }
    });
  }
  if(Object.keys(formData).length){
    toSend.formData = formData;
  }
  var jsn = req.body.json;
  if(typeof jsn === 'object' && jsn !== null && Object.keys(json).length){
    toSend.json = jsn;
  }
  if(Array.isArray(req.body.multipart)){
    var bds = req.body.multipart, ln = bds.length;
    for(var z=0;z<ln;z++){
      if(bds[z].body && typeof bds[z].body === 'object' && utils.isStr(bds[z].body.filePath)){
        rs = getFile(bds[z].body);
        if(rs){
          bds[z].body = rs;
        }
      }
    }
    toSend.multipart = bds;
  }
  var cbs = function(err,rs,body){
    var ars = {};
    if(err) {
      ars.error = err;
    }
    if(body){
      ars.output = body;
    }
    if(ars){
      if(ars.statusCode) {
        ars.statusCode = ars.statusCode;
      }
      if(!(ars.output) && ars.body){
        ars.output = ars.body;
      }
    }
    if(utils.lastValue(req.body, 'options', 'parseResponse') === true){
      getParsedResponse({ headers : rs.headers },rs,function(ab){
        res.send({ actual : ars, multipart : ab });
      });
    } else {
      res.send(ars);
    }
  };
  request(toSend,cbs);
}

module.exports = func;
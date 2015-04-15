'use strict';
var interpolate = require('./util/interpolate')
  , Promise = require('es6-promise').Promise
  , Condition   = require('./util/condition')
  , ValidationError = require('./util/validation-error')
  , getter = require('property-expr').getter
  , locale = require('./locale.js').mixed
  , _ = require('./util/_')
  , cloneDeep = require('./util/clone')
  , BadSet = require('./util/set');



module.exports = SchemaType

function SchemaType(options = {}){
  if ( !(this instanceof SchemaType))
    return new SchemaType()

  this._deps        = []
  this._conditions  = []
  this._options     = { abortEarly: true }
  this._exclusive   = Object.create(null)
  this._whitelist   = new BadSet()
  this._blacklist   = new BadSet()
  this.tests        = []
  this.transforms   = []

  if (_.has(options, 'default'))
    this._default = options.default

  this._type = options.type || 'mixed'
}

SchemaType.prototype = {

  __isYupSchema__: true,

  constructor: SchemaType,

  clone(){
    return cloneDeep(this);
  },

  concat(schema){
    if( schema._type !== this._type )
      throw new TypeError(`You cannot \`concat()\` schema's of different types: ${this._type} and ${schema._type}`)

    var next = _.merge(this.clone(), schema.clone())

    // undefined isn't merged over, but is a valid value for default
    if ( schema._default === undefined && _.has(schema, '_default') )
      next._default = schema._default

    // trim exclusive tests, take the most recent ones
    next.tests = _.uniq(next.tests.reverse(), 
      (fn, idx) => next[fn.VALIDATION_KEY] ? fn.VALIDATION_KEY : idx).reverse()

    return next
  },

  isType(v) {
    if( this._nullable && v === null) return true
    return !this._typeCheck || this._typeCheck(v)
  },

  cast(_value, _opts) {
    var schema = this._resolve((_opts|| {}).context)
    return schema._cast(_value, _opts)
  },

  _cast(_value) {
    let value = _value === undefined ? _value
      : this.transforms.reduce(
          (value, transform) => transform.call(this, value, _value), _value)

    if( value === undefined && _.has(this, '_default') )
      value = this.default()

    return value
  },

  _resolve(context){
    var schema  = this;
    
    return this._conditions.reduce(function(schema, match){
      if(!context) throw new Error('missing the context necessary to cast this value')
      return match.resolve(schema, getter(match.key)(context))
    }, schema)
  },

  //-- tests
  _validate(value, _opts, _state) {
    var valids   = this._whitelist
      , invalids = this._blacklist
      , context  = (_opts || {}).context || _state.parent
      , schema, valid, state, endEarly, isStrict;

    state    = _state
    schema   = this._resolve(context)
    isStrict = schema._option('strict', _opts)
    endEarly = schema._option('abortEarly', _opts)

    !state.path && (state.path = 'this')

    var errors = [];

    if( !state.isCast && !isStrict )
      value = schema._cast(value, _opts)

    if( value !== undefined && !schema.isType(value) ){
      errors.push(`value: ${value} must be a ${schema._type} type`)
      return Promise.reject(new ValidationError(errors))
    }

    if( valids.length ) {
      valid = valids.has(value)

      if( !valid ) 
        return Promise.reject(new ValidationError(errors.concat(
            schema._whitelistError({ values: valids.values().join(', '), path: state.path }))
          ))
    }

    if( invalids.has(value) ) {
      return Promise.reject(new ValidationError(errors.concat(
          schema._blacklistError({ values: invalids.values().join(', '), path: state.path }))
        ))
    }

    let result = schema.tests.map(fn => fn.call(schema, value, state))

    result = endEarly
      ? Promise.all(result)
      : _.settled(result).then( results => {
        errors = results.reduce( 
          (arr, r) => !r.fulfilled ? arr.concat([ r.value.errors ]) : arr, errors)
      })

    return result.then(() => {
        if ( errors.length ) 
          throw new ValidationError(errors)

        return value
      });
  },

  validate(value, options, cb){
    if (typeof options === 'function')
      cb = options, options = {}

    return nodeify(this._validate(value, options, {}), cb)
  },

  isValid(value, options, cb){
    if (typeof options === 'function')
      cb = options, options = {}

    return nodeify(this
      .validate(value, options)
      .then(() => true)
      .catch(err => {
        if ( err instanceof ValidationError) return false
        throw err
      }), cb)
    },

  default(def) {
    if( arguments.length === 0){
      var dflt = this._default
      return typeof dflt === 'function' 
        ? dflt.call(this) : cloneDeep(dflt)
    }

    var next = this.clone()
    next._default = def
    return next
  },

  strict() {
    var next = this.clone()
    next._options.strict = true
    return next
  },

  required(msg) {
    return this.test({ 
      name: 'required', 
      exclusive: true, 
      message:  msg || locale.required,
      test: value => value != null 
    })
  },

  nullable(value) {
    var next = this.clone()
    next._nullable = value === false ? false : true
    return next
  },

  transform(fn) {
    var next = this.clone();
    next.transforms.push(fn)
    return next
  },

  test(name, message, test, useCallback) {
    var opts = name
      , next = this.clone()
      , errorMsg, isExclusive;

    if(typeof name === 'string')
      opts = { name, test, message, useCallback, exclusive: false }

    if( next._whitelist.length )
      throw new TypeError('Cannot add tests when specific valid values are specified')

    errorMsg = interpolate(opts.message)
    isExclusive = opts.name && next._exclusive[opts.name] === true

    if( opts.exclusive ){
      if (!opts.name)
        throw new TypeError('You cannot have an exclusive validation without a name to identify it')
      
      next._exclusive[opts.name] = true
      validate.VALIDATION_KEY = opts.name
    }

    if( isExclusive )
      next.tests = next.tests.filter( fn => fn.VALIDATION_KEY !== opts.name)

    next.tests.push(validate)

    return next

    function validate(value, state) {
      return new Promise((resolve, reject) => {
        !opts.useCallback
          ? resolve(opts.test.call(this, value))
          : opts.test.call(this, value, (err, valid) => err ? reject(err) : resolve(valid))
      })
      .then(valid => {
        if (!valid) 
          throw new ValidationError(errorMsg({ path: state.path, ...opts.params }))
      })
    }
  },

  when(key, options){
    var next = this.clone();

    next._deps.push(key)
    next._conditions.push(new Condition(key, next, options))
    return next
  },

  oneOf(enums, msg) {
    var next = this.clone()

    if( next.tests.length )
      throw new TypeError('Cannot specify values when there are validation rules specified')

    next._whitelistError = interpolate(msg || next._whitelistError || locale.oneOf)

    enums.forEach( val => {
      next._blacklist.delete(val)
      next._whitelist.add(val)
    })

    return next
  },

  notOneOf(enums, msg) {
    var next = this.clone()

    next._blacklistError = interpolate(msg || next._blacklistError || locale.notOneOf)

    enums.forEach( val => {
      next._whitelist.delete(val)
      next._blacklist.add(val)
    })

    return next
  },

  _option(key, overrides){
    return _.has(overrides, key)
      ? overrides[key] : this._options[key]
  }
}

var aliases = {
  oneOf: ['equals']
}

for( var method in aliases ) if ( _.has(aliases, method) )
  aliases[method].forEach(
    alias => SchemaType.prototype[alias] = SchemaType.prototype[method])
  


function nodeify(promise, cb){
  if(typeof cb !== 'function') return promise

  promise.then(val => cb(null, val), err => cb(err))
}
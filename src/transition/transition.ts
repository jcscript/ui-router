/// <reference path='../../bower_components/DefinitelyTyped/angularjs/angular.d.ts' />

import {runtime} from "../common/angular1";
import {trace} from "../common/trace";
import {$transition, matchState} from "./transitionService";
import Resolvable from "../resolve/resolvable";
import Path from "../resolve/path";
import PathElement from "../resolve/pathElement";
import {RejectFactory} from "./rejectFactory"
import {StateParams} from "../state/state";
import {ViewContext} from "../view/viewContext";
import {defaults, eq, extend, filter, flatten, forEach, identity, invoke, is, isEq, isFunction, isObject, isPromise,
    map, noop, not, objectKeys, parse, pattern, pipe, pluck, prop, toJson, unnest, unroll, val} from "../common/common";

var transitionCount = 0, REJECT = new RejectFactory();

function TransitionStep(pathElement, fn, locals, pathContext, options) {
  options = defaults(options, {
    async: true,
    rejectIfSuperseded: true,
    current: noop,
    transition: null,
    trace: false,
    data: {}
  });

  /**
   * Validates the result map as a "resolve:" style object.
   * Creates Resolvable objects from the result object and adds them to the target object
   */
  function mapNewResolves(resolves: Object) {
    var invalid = filter(resolves, not(isFunction)), keys = objectKeys(invalid);
    if (keys.length)
      throw new Error("Invalid resolve key/value: ${keys[0]}/${invalid[keys[0]]}");

    // If result is an object, it should be a map of strings to functions.
    return map(resolves, function(val, key) {
      return new Resolvable(key, val, pathElement.state);
    });
  }

  function handleHookResult(hookResult) {
    var transitionResult = mapHookResult(hookResult);
    if (options.trace) trace.traceHookResult(hookResult, transitionResult, options);
    return transitionResult;
  }

  /**
   * Handles transition abort and transition redirect. Also adds any returned resolvables
   * to the pathContext for the current pathElement.  If the transition is rejected, then a rejected
   * promise is returned here, otherwise undefined is returned.
   */
  var mapHookResult = pattern([
    // Transition is no longer current
    [not(isEq(options.current, val(options.transition))), pipe(options.current, REJECT.superseded.bind(REJECT))],
    // If the hook returns false, abort the current Transition
    [eq(false), val(REJECT.aborted("Hook aborted transition"))],
    // If the hook returns a Transition, halt the current Transition and redirect to that Transition.
    [is(Transition), REJECT.redirected.bind(REJECT)],
    [isPromise, function(result) { return result.then(handleHookResult); }],
    // If the hook returns any new resolves, add them to the pathContext via the PathElement
    [isObject, function(result) {
      return pathElement.addResolvables(mapNewResolves(result));
    }]
  ]);

  function invokeStep() {
    if (options.trace) trace.traceHookInvocation(this, options);
    if (options.rejectIfSuperseded && /* !this.isActive() */ options.transition !== options.current()) {
      return REJECT.superseded(options.current());
    }

    // TODO: Need better integration of returned promises in synchronous code.
    if (!options.async) {
      return handleHookResult(pathElement.invokeNow(fn, locals, pathContext));
    }
    return pathElement.invokeLater(fn, locals, pathContext, options).then(handleHookResult);
  }

  function transitionStepToString() {
    var event = parse("data.eventType")(options) || "internal",
        name = fn.name || "(anonymous)",
        from = parse("data.from.name")(options),
        to = parse("data.to.name")(options),
        state = parse("data.pathElement.state.name")(options);
    return `Step ${event} (fn: '${name}', match:{from: '${from}', to: '${to}'}, ${pathContext.toString()})`;
  }

  extend(this, {
    async: options.async,
    rejectIfSuperseded: options.rejectIfSuperseded,
    state: pathElement.state,
    data:  options.data,
    invokeStep: () => invokeStep(),
    toString: transitionStepToString
  });
}

function runSynchronousHooks(hooks, swallowExceptions: boolean = false) {
  var promises = [];
  for (var i = 0; i < hooks.length; i++) {
    try {
      var hookResult = hooks[i].invokeStep();
      // If a hook returns a promise, that promise is added to an array to be resolved asynchronously.
      if (hookResult && isPromise(hookResult))
        promises.push(hookResult);
    } catch (ex) {
      if (!swallowExceptions) throw ex;
      console.log("Swallowed exception during synchronous hook handler: " + ex); // TODO: What to do here?
    }
  }

  return promises.reduce(function(memo, val) {
    return memo.then(function() { return val; });
  }, runtime.$q.when(true));
}

/**
 * @ngdoc object
 * @name ui.router.state.type:Transition
 *
 * @description
 * Represents a transition between two states, and contains all contextual information about the
 * to/from states and parameters, as well as the list of states being entered and exited as a
 * result of this transition.
 *
 * @param {Object} from The origin {@link ui.router.state.$stateProvider#state state} from which the transition is leaving.
 * @param {Object} to The target {@link ui.router.state.$stateProvider#state state} being transitioned to.
 * @param {Object} options An object hash of the options for this transition.
 *
 * @returns {Object} New `Transition` object
 */
export function Transition(from, to, options) {
  options = extend(options, { current: val(this) });
  var transition = this; // Transition() object

  var deferreds = {
    prehooks: runtime.$q.defer(), // Resolved when the transition is complete, but success callback not run yet
    posthooks: runtime.$q.defer(), // Resolved when the transition is complete, after success callbacks
    redirects: runtime.$q.defer() // Resolved when any transition redirects are complete
  };

  // grab $transition's current path
  var toPath: Path, retained: Path, entering: Path, exiting: Path; // Path() objects
  var keep = 0, state, hasCalculated = false;

  var fromState = from.$state();
  var fromParams = extend(new StateParams(), from.params());
  var fromPath = new Path(fromState.path);

  var toState = to.$state();
  var toParams = (options.inherit && toState) ? fromParams.$inherit(to.params(), fromState, toState) : to.params();
  toParams = toState ? extend(new StateParams(), toState.params.$$values(toParams)) : toParams;
  to = (toParams && to.params(toParams)) || to;

  function calculateTreeChanges() {
    if (hasCalculated) return;

    function nonDynamicParams(state) {
      return state.params.$$filter(not(prop('dynamic')));
    }

    if (to.valid()) {
      state = toState.path[keep];
      while (state && state === fromState.path[keep] && state !== options.reloadState && nonDynamicParams(state).$$equals(toParams, fromParams)) {
        keep++;
        state = toState.path[keep];
      }
    }

    // fromPath contains previously resolved data; emptyToPath has nothing resolved yet.
    retained = fromPath.slice(0, keep);
    exiting = fromPath.slice(keep);
    entering = to.valid() ? new Path(toState.path).slice(keep) : new Path([]);
    toPath = retained.concat(entering);

    hasCalculated = true;
  }

  extend(this, {
    $id: ++transitionCount,
    /**
     * @ngdoc function
     * @name ui.router.state.type:Transition#$from
     * @methodOf ui.router.state.type:Transition
     *
     * @description
     * Returns the origin state of the current transition, as passed to the `Transition` constructor.
     *
     * @returns {StateReference} The origin state reference of the transition ("from state").
     */
    $from: function() { return from; },

    /**
     * @ngdoc function
     * @name ui.router.state.type:Transition#$to
     * @methodOf ui.router.state.type:Transition
     *
     * @description
     * Returns the target state of the current transition, as passed to the `Transition` constructor.
     *
     * @returns {StateReference} The state reference the transition is targetting ("to state")
     */
    $to: function() { return to; },

    from: function() { return from.identifier(); },
    to: function() { return to.identifier(); },

    /**
     * @ngdoc function
     * @name ui.router.state.type:Transition#is
     * @methodOf ui.router.state.type:Transition
     *
     * @description
     * Determines whether two transitions are equivalent.
     */
    is: function(compare) {
      if (compare instanceof Transition) {
        // TODO: Also compare parameters
        return this.is({ to: compare.$to().$state().name, from: compare.$from.$state().name });
      }
      return !(
        (compare.to && !matchState(this.$to().$state(), compare.to)) ||
        (compare.from && !matchState(this.$from().$state(), compare.from))
      );
    },

    /**
     * @ngdoc function
     * @name ui.router.state.type:Transition#params
     * @methodOf ui.router.state.type:Transition
     *
     * @description
     * Gets the calculated StateParams object for the transition target.
     *
     * @returns {StateParams} the StateParams object for the transition.
     */
    params: function() {
      return toParams;
    },

    /**
     * @ngdoc function
     * @name ui.router.state.type:Transition#previous
     * @methodOf ui.router.state.type:Transition
     *
     * @description
     * Gets the previous transition from which this transition was redirected.
     *
     * @returns {Object} A `Transition` instance, or `null`.
     */
    previous: function() {
      return options.previous || null;
    },

    /**
     * @ngdoc function
     * @name ui.router.state.type:Transition#options
     * @methodOf ui.router.state.type:Transition
     *
     * @description
     * Returns all options passed to the constructor of this `Transition`.
     */
    options: function() {
      return options;
    },

    /**
     * @ngdoc function
     * @name ui.router.state.type:Transition#entering
     * @methodOf ui.router.state.type:Transition
     *
     * @description
     * Gets the states being entered.
     *
     * @returns {Array} Returns an array of states that will be entered in this transition.
     */
    entering: function() {
      calculateTreeChanges();
      return pluck(entering.elements, 'state');
    },

    /**
     * @ngdoc function
     * @name ui.router.state.type:Transition#exiting
     * @methodOf ui.router.state.type:Transition
     *
     * @description
     * Gets the states being exited.
     *
     * @returns {Array} Returns an array of states that will be exited in this transition.
     */
    exiting: function() {
      calculateTreeChanges();
      var exitingStates = <any[]> pluck(exiting.elements, 'state');
      exitingStates.reverse();
      return exitingStates;
    },

    /**
     * @ngdoc function
     * @name ui.router.state.type:Transition#retained
     * @methodOf ui.router.state.type:Transition
     *
     * @description
     * Gets the states being retained.
     *
     * @returns {Array} Returns an array of states that were entered in a previous transition that
     *           will not be exited.
     */
    retained: function() {
      calculateTreeChanges();
      return pluck(retained.elements, 'state');
    },

    context: function context(pathElement) {
      return new ViewContext(pathElement, toPath, options, runtime.$injector);
    },

    views: function(states) {
      calculateTreeChanges();
      if (!states) states = entering.states();

      return unnest(map(states, function(state) {
        var elem = toPath.elementForState(state);
        var toList = unroll(function(view) {
          return [transition.context(elem), view, toParams];
        });
        return toList(state.views);
      }));
    },

    /**
     * @ngdoc function
     * @name ui.router.state.type:Transition#redirect
     * @methodOf ui.router.state.type:Transition
     *
     * @description
     * Creates a new transition that is a redirection of the current one. This transition can
     * be returned from a `$transitionProvider` hook, `$state` event, or other method, to
     * redirect a transition to a new state and/or set of parameters.
     *
     * @returns {Transition} Returns a new `Transition` instance.
     */
    redirect: function(newTo, newOptions) {
      // This code wasn't working because 'params' isn't a thing
      //if (newTo.state() === to && newTo.params() === params) return this;

      return new Transition(from, newTo, extend(newOptions || this.options(), {
        previous: this
      }));
    },

    /**
     * @ngdoc function
     * @name ui.router.state.type:Transition#ignored
     * @methodOf ui.router.state.type:Transition
     *
     * @description
     * Indicates whether the transition should be ignored, based on whether the to and from states are the
     * same, and whether the `reload` option is set.
     *
     * @returns {boolean} Whether the transition should be ignored.
     */
    ignored: function() {
      return !options.reload && toState === fromState && toState.params.$$filter(not(prop('dynamic'))).$$equals(toParams, fromParams);
    },

    run: function() {
      if (options.trace) trace.traceTransitionStart(this);
      var baseHookOptions = {
        trace: options.trace,
        transition: transition,
        current: function() { return $transition.transition; }
      };

      /**
       * returns an array of transition steps (promises) that matched
       * 1) the eventType
       * 2) the to state
       * 3) the from state
       */
      function makeSteps(eventType, to, from, pathElement, locals, pathContext, options ?: Object): any[] {
        // trace stuff
        var stepData = {
          eventType: eventType,
          to: to,
          from: from,
          pathElement: pathElement,
          locals: locals,
          pathContext: pathContext
        };
        options = extend(options || {}, baseHookOptions, { data: stepData });

        var hooks = <any[]> (<any> $transition).$$hooks(eventType);

        return map(filter(hooks, invoke('matches', [to, from])), function (hook) {
          return new TransitionStep(pathElement, hook.callback, locals, pathContext, options);
        });
      }

      /** Returns a TransitionStep which resolves an entire path according to a given resolvePolicy */
      function makeEagerResolvePathStep(path, locals) {
        if (!path.elements.length) return null;
        var options = extend({ resolvePolicy: 'eager' }, baseHookOptions);
        function $eagerResolvePath() { return path.resolvePath(options); }
        return new TransitionStep(path.last(), $eagerResolvePath, locals, path, options);
      }

      /** Returns a TransitionStep which resolves a single path element according to a given resolvePolicy */
      function makeLazyResolvePathElementStep(path, pathElement, locals) {
        var options = extend({ resolvePolicy: 'lazy' }, baseHookOptions);
        function $resolvePathElement() { return pathElement.resolvePathElement(path, options); }
        return new TransitionStep(pathElement, $resolvePathElement, locals, path, options);
      }

      var current = options.current;
      calculateTreeChanges();

      if (transition.ignored()) {
        if (options.trace) trace.traceTransitionIgnored(transition);
        $transition.transition = null;
        var ignored = REJECT.ignored();
        forEach(deferreds, function(def) { def.reject(ignored.reason); });
        return ignored;
      }

      $transition.transition = transition;

      var tLocals = { $transition$: transition };
      var rootPE = new PathElement(fromState.root());
      var rootPath = new Path([rootPE]);
      var exitingElements = exiting.slice(0).reverse().elements;
      var enteringElements = entering.elements;
      var to = transition.$to().$state(), from = transition.$from().$state();

      // Build a bunch of arrays of promises for each step of the transition
      // TODO: Provide makeSteps with the StateReference, not the $state().
      var onBeforeHooks = makeSteps("onBefore", to, from, rootPE, tLocals, rootPath, { async: false });

      var onInvalidHooks = makeSteps("onInvalid", to, from, rootPE, tLocals, rootPath);

      var onStartHooks = makeSteps("onStart", to, from, rootPE, tLocals, rootPath);

      var transitionOnHooks = makeSteps("on", to, from, rootPE, tLocals, rootPath);

      var exitingStateHooks = map(exitingElements, function(elem) {
        var stepLocals = { $state$: elem.state,  $stateParams: elem.state.params.$$values(fromParams) };
        var locals = extend({}, tLocals, stepLocals);
        var steps = makeSteps("exiting", to, elem.state, elem, locals, fromPath);

        return !elem.state.self.onExit ? steps : steps.concat([
          new TransitionStep(elem, elem.state.self.onExit, locals, fromPath, baseHookOptions)
        ]);
      });

      var enteringStateHooks = map(enteringElements, function(elem) {
        var stepLocals = { $state$: elem.state,  $stateParams: elem.state.params.$$values(fromParams) };
        var locals = extend({}, tLocals, stepLocals);
        var lazyResolveStep = makeLazyResolvePathElementStep(toPath, elem, locals);
        var steps = [lazyResolveStep].concat(makeSteps("entering", elem.state, from, elem, locals, toPath));

        return !elem.state.self.onEnter ? steps : steps.concat([
          new TransitionStep(elem, elem.state.self.onEnter, locals, toPath, baseHookOptions)
        ]);
      });

      var successErrorOptions = { async: false, rejectIfSuperseded: false };

      function successHooks(outcome) {
        var result = transition.$to().state();
        if (options.trace) trace.traceSuccess(result, transition);
        deferreds.prehooks.resolve(result);
        var onSuccessHooks = makeSteps("onSuccess", to, from, rootPE, tLocals, rootPath, successErrorOptions);
        runSynchronousHooks(onSuccessHooks, true);
        deferreds.posthooks.resolve(result);
      }

      function errorHooks(error) {
        if (options.trace) trace.traceError(error, transition);
        deferreds.prehooks.reject(error);
        var onErrorLocals = extend({}, tLocals, { $error$: error });
        var onErrorHooks = makeSteps("onError", to, from, rootPE, onErrorLocals, rootPath, successErrorOptions);
        runSynchronousHooks(onErrorHooks, true);
        deferreds.posthooks.reject(error);
      }

      var eagerResolves = makeEagerResolvePathStep(toPath, tLocals);

      // Set up a promise chain. Add the steps' promises in appropriate order to the promise chain.
      var invalidOrStartHooks = transition.$to().valid() ? onStartHooks : onInvalidHooks;
      var asyncSteps = filter(flatten([invalidOrStartHooks, transitionOnHooks, eagerResolves, exitingStateHooks, enteringStateHooks]), identity);

      // -----------------------------------------------------------------------
      // Transition Steps
      // -----------------------------------------------------------------------

      // ---- Synchronous hooks ----
      // Run the "onBefore" hooks and save their promises
      var chain = runSynchronousHooks(onBeforeHooks);

      // ---- Asynchronous section ----

      // The results of the sync hooks is a promise chain (rejected or otherwise) that begins the async portion of the transition.
      // Build the rest of the chain off the sync promise chain out of all the asynchronous steps
      forEach(asyncSteps, function (step) {
        chain = chain.then(step.invokeStep);
      });

      // When the last step of the chain has resolved or any step has rejected (i.e., the transition is completed),
      // invoke the registered success or error hooks when the transition is completed.
      chain = chain.then(successHooks).catch(errorHooks);

      // Return the overall transition promise, which is resolved/rejected in successHooks/errorHooks
      return transition.promise;
    },

    isActive: isEq(options.current, val(this)),

    abort: function() {
      if (transition.isActive()) {
        $transition.transition = null;
      }
    },

    // Expose three promises to users of Transition
    promise: deferreds.posthooks.promise,
    prepromise: deferreds.prehooks.promise,
    redirects: deferreds.redirects.promise,

    toString: function() {
      var fromStateOrName = transition.from();
      var toStateOrName = transition.to();

      // (X) means the to state is invalid.
      var id = transition.$id,
        from = isObject(fromStateOrName) ? fromStateOrName.name : fromStateOrName,
        fromParams = toJson(transition.$from().params()),
        toValid = transition.$to().valid() ? "" : "(X) ",
        to = isObject(toStateOrName) ? toStateOrName.name : toStateOrName,
        toParams = toJson(transition.params());
      return `Transition#${id}( '${from}'${fromParams} -> ${toValid}'${to}'${toParams} )`;
    }
  });
}
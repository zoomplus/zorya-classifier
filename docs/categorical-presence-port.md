# Caller-owned categorical presence composition

`examples/categorical-presence-port.ts` shows how to wrap an injected public `DecisionPort` for services that answer closed Choice questions. The wrapper sends the original Choice questions and translated presence questions together in one delegate call. The translated classes are `present`, `absent`, and `unknown`; their instructions retain the exact original proposition. Existing scored Choice answers are returned unchanged. For translated questions, a valid probability distribution is reduced to the first maximum in criteria order, while a rank-only answer remains categorical and does not acquire invented scores.

The example is source code in this repository, not an npm subpath export. To adapt it in an application, install the public package and its direct Zod dependency, copy the example source into your project, and inject a `DecisionPort` you have configured:

```sh
npm install zorya-classifier zod@3.25.76
```

```ts
import { createClassifier, type DecisionPort } from 'zorya-classifier'
import { createCategoricalPresencePort } from './categorical-presence-port.js'

declare const configuredDecision: DecisionPort // supplied by your application

const classifier = createClassifier({
  decision: createCategoricalPresencePort(configuredDecision),
  timeoutMs: 120_000, // benchmark recipe limit; production callers should choose their own deadline
})
// After your operations finish, await classifier.dispose().
```

The caller owns the wrapped port and its delegate. Inject the returned port into `createClassifier({ decision: ... })`; choose and configure the actual service outside this example. The wrapper snapshots the request before awaiting, validates closed IDs and answer shape, passes through the caller's `AbortSignal`, and fails if cancellation arrives during the delegate call. To preserve auditability, record the delegate's raw response at the transport boundary before this wrapper converts it.

This composition mirrors the categorical protocol selected in development. That profile still requires independent blind qualification; neither the source example nor fixture tests qualify a model or make this a default SDK behavior. The 120-second timeout is the benchmark recipe, not a recommended universal production setting. The offline tests exercise only local fixtures; they make no provider or native calls.

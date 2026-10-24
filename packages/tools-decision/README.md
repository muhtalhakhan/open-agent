# @open-agent/tools-decision

Four tools for the small, typed judgments an agent makes all day, answered by a `DecisionModel` (Jev, TypeSafe's classifier, today) with calibrated probabilities instead of an LLM writing prose:

| Tool              | For                                                    | Returns per item                                   |
| ----------------- | ------------------------------------------------------ | -------------------------------------------------- |
| `classify_items`  | Labelling many items with one of your classes          | `label`, `probability`, `decision: auto \| review` |
| `check_claims`    | Yes/no questions about one piece of evidence           | `probability`, `verdict: yes \| no \| uncertain`   |
| `rank_candidates` | Picking which files, docs or results answer a question | `relevance`, `relevant`, plus `any_relevant`       |
| `score_items`     | Rating many items on one ordered scale                 | nearest `level` and `label`, `score`, `decision`   |

`auto` means the answer is clear enough to act on (thresholds in `src/tools.ts`, strict on purpose); `review` means the model should look itself.

```ts
import { JevDecisionModel } from '@open-agent/providers'
import { mountDecisionTools } from '@open-agent/tools-decision'

const model = new JevDecisionModel({ apiKey: process.env.TYPESAFE_API_KEY! })
const dispose = mountDecisionTools(registry, model, { destination: 'api.typesafe.ai' })
```

## Security

The tools are `safe`: they read nothing and change nothing. They do send whatever the model passes them to the configured decision model, which is a third party. Configuring the key is the consent for that. Each tool declares `fixedDestination`, because its arguments can't change where the data goes. So URLs inside the evidence are treated as payload, and the exfiltration rule in `@open-agent/agent` doesn't escalate them.

Inputs are bounded before anything is sent:

- at most 64 items, checks or levels per call;
- at most 250 candidates;
- 4,000 characters per item, with truncated items flagged in the result.

`JevDecisionModel` also refuses requests over Jev's context size before paying for them.

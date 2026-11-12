---
status: proposed
---

# Plugins depend on capabilities, never on each other

A DataGateway brings one upstream's data in, in the server's shape: games for the game catalog, and what a user keeps under their own upstream account, such as their collection and their plays. It brings data in by answering the server's calls, and later also by pushing changes its upstream announces, such as IGDB's webhooks, as topics (#721, mechanism undecided). Either way it never writes the server's records. The server matches, stores and decides who may see what. Everything the server knows about its users, and everything worked out from it, such as players, collection history and insights, is the server's own and lives in the core. The other plugin categories are for strategies that can be swapped, such as recommendation engines, and for sending things out, such as notification channels and calendar sync.

Plugins never extend one another, and never require a named plugin. A plugin feature that needs something another plugin provides names a **capability** or a piece of the server's own data instead. The feature works while some enabled DataGateway serves that capability, whichever one it is, and is unavailable, saying why, while none does. The server works this out when it reads the feature's state, as it does for consent standing (ADR 0004), so no admin has to remember which plugins go together.

## Considered options

- **Plugins that add capabilities to an installed DataGateway**, for example a third-party plugin adding play sync to the BoardGameGeek DataGateway. Rejected. The extending plugin would act through the DataGateway's outbound domains, secrets and consent, borrowing authority that was never consented to it. It would also tie the two plugins' versions, install order, uninstall and restarts together. Capability routing already composes them: a second DataGateway for the same upstream can declare only the capability it adds, and the server routes that capability to it.
- **Hard dependencies between plugins** ("requires plugin X, version Y"). Deferred until a real case needs one. They bring install-order rules, uninstalls that are refused or cascade, version ranges and a chain of consents. Until then, plugins hear from each other only through events the server carries: plugin-emitted events and topics.
- **Insights and other computed views as plugins.** Rejected for anything the product itself offers. A plugin's context is deliberately narrow (`GLOSSARY.md`, **Plugin context**). To compute insights it would need read access to every user's plays and collection, a high-risk consent for a basic feature. Household views must also hold to reach and collection sharing, which only the core can promise. A plugin may still offer an extra view through a category built for it, using the permissions its users consent to.

## Consequences

- The DataGateway contract gains capabilities for a user's upstream account: a collection sync shaped for any upstream (Steam first, #936; BoardGameGeek, #1227), and play sync (#1228).
- A capability a feature depends on may be one a DataGateway pushes, such as a topic of game changes (#721), as well as one it answers calls for. The rule is the same: the feature names the capability, not the DataGateway.
- A user has at most one upstream account per upstream, not per DataGateway, so two DataGateways for BoardGameGeek share one link. This builds on the upstream key #925 adds to the interview, and amends #935.
- Players, collection history and insights are core work: #1230, #1231 and the insights epic, #1233.
- The plugin manifest gains a way for a feature to name the capabilities it needs, and a feature's state gains a reason for being unavailable when no enabled DataGateway serves one.
- A plugin that only makes sense for one upstream, such as an importer for BoardGameGeek's GeekLists, is a sign the work belongs in that upstream's DataGateway as a capability.

```
┌──────────────────────────────────────────────────────────────┐
│  Main App                                                    │
│  - REST/GraphQL API                                          │
│  - Auth, CASL, all domain logic                              │
└────────────┬──────────────────────────┬──────────────────────┘
             │ gRPC                     │ AMQP (async tasks)
             ▼                          ▼
┌─────────────────────────┐  ┌──────────────────────────────────┐
│  Gateway Coordinator    │  │  RabbitMQ                        │
│                         │  │  - Sync jobs, long-running tasks │
│                         │  └──────────────┬───────────────────┘
│  - GatewayClientRegistry│                 │
│  - Reflection cache     │◄───────────────-┘ (coordinator also
│  - Circuit breaking     │     consumes sync job messages)
│  - Capability routing   │
└────┬──────┬──────┬──────┘
     │      │      │  gRPC (dynamic, runtime-initialized)
     ▼      ▼      ▼
  [BGG]  [Steam] [IGDB]
  gateway gateway gateway
```

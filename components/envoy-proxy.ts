import * as pulumi from "@pulumi/pulumi";
import * as docker from "@pulumi/docker";
import * as command from "@pulumi/command";
import {
  ENVOY_IMAGE,
  ENVOY_UID,
  ENVOY_CA_CERT_PATH,
  ENVOY_MITM_CERTS_HOST_DIR,
  ENVOY_MITM_CERTS_CONTAINER_DIR,
} from "../config";

export interface EnvoyProxyArgs {
  /** SSH connection args for remote commands */
  connection: pulumi.Input<command.types.input.remote.ConnectionArgs>;
  /** Docker host URI, e.g. "ssh://root@<ip>" */
  dockerHost: pulumi.Input<string>;
  /** Sidecar container name for network_mode */
  sidecarContainerName: pulumi.Input<string>;
  /** Host path to the envoy.yaml config file (from EnvoyEgress) */
  envoyConfigPath: pulumi.Input<string>;
  /** SHA256 hash of envoy.yaml (triggers container replacement on config change) */
  envoyConfigHash: string;
  /** Domains with MITM TLS inspection enabled (from EnvoyEgress) */
  inspectedDomains: string[];
  /** Unique name for this gateway instance */
  profile: string;
}

export class EnvoyProxy extends pulumi.ComponentResource {
  /** Signal that envoy is healthy and ready */
  public readonly envoyReady: pulumi.Output<string>;

  constructor(
    name: string,
    args: EnvoyProxyArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("openclaw:net:EnvoyProxy", name, {}, opts);

    const envoyName = `envoy-${args.profile}`;

    const dockerProvider = new docker.Provider(
      `${name}-docker`,
      { host: args.dockerHost },
      { parent: this },
    );

    // Build volumes list
    const volumes: docker.types.input.ContainerVolume[] = [
      {
        hostPath: args.envoyConfigPath,
        containerPath: "/etc/envoy/envoy.yaml",
        readOnly: true,
      },
      {
        hostPath: ENVOY_CA_CERT_PATH,
        containerPath: "/etc/envoy/ca-cert.pem",
        readOnly: true,
      },
    ];
    if (args.inspectedDomains.length > 0) {
      volumes.push({
        hostPath: ENVOY_MITM_CERTS_HOST_DIR,
        containerPath: ENVOY_MITM_CERTS_CONTAINER_DIR,
        readOnly: true,
      });
    }

    // Envoy container — shares sidecar's network namespace
    // Matches reference docker-compose.yml `envoy` service
    const envoyContainer = new docker.Container(
      `${name}-envoy`,
      {
        name: envoyName,
        image: ENVOY_IMAGE,
        restart: "unless-stopped",
        networkMode: pulumi.interpolate`container:${args.sidecarContainerName}`,
        envs: [`ENVOY_UID=${ENVOY_UID}`],
        healthcheck: {
          tests: ["CMD", "bash", "-c", "echo > /dev/tcp/localhost/10000"],
          interval: "5s",
          timeout: "3s",
          retries: 5,
          startPeriod: "5s",
        },
        volumes,
        labels: [
          { label: "openclaw.config-hash", value: args.envoyConfigHash },
        ],
      },
      {
        parent: this,
        provider: dockerProvider,
      },
    );

    // Wait for Envoy to pass healthcheck
    const envoyHealthy = new command.remote.Command(
      `${name}-envoy-healthy`,
      {
        connection: args.connection,
        create: pulumi.interpolate`for i in $(seq 1 30); do if [ "$(docker inspect --format='{{.State.Health.Status}}' ${envoyName} 2>/dev/null)" = "healthy" ]; then exit 0; fi; sleep 2; done; echo "ERROR: Envoy did not become healthy within 60s" >&2; exit 1`,
        triggers: [envoyContainer.id],
      },
      { parent: this, dependsOn: [envoyContainer] },
    );

    this.envoyReady = envoyHealthy.stdout;

    this.registerOutputs({
      envoyReady: this.envoyReady,
    });
  }
}

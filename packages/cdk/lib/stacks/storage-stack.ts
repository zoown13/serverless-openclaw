import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as ecr from "aws-cdk-lib/aws-ecr";
import type { Construct } from "constructs";
import { TABLE_NAMES } from "@serverless-openclaw/shared";

export class StorageStack extends cdk.Stack {
  // DynamoDB tables
  public readonly conversationsTable: dynamodb.Table;
  public readonly settingsTable: dynamodb.Table;
  public readonly taskStateTable: dynamodb.Table;
  public readonly connectionsTable: dynamodb.Table;
  public readonly pendingMessagesTable: dynamodb.Table;

  // S3 buckets
  public readonly dataBucket: s3.Bucket;

  // ECR
  public readonly ecrRepository: ecr.Repository;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── DynamoDB Tables ──

    this.conversationsTable = new dynamodb.Table(this, "Conversations", {
      tableName: TABLE_NAMES.CONVERSATIONS,
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.settingsTable = new dynamodb.Table(this, "Settings", {
      tableName: TABLE_NAMES.SETTINGS,
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.taskStateTable = new dynamodb.Table(this, "TaskState", {
      tableName: TABLE_NAMES.TASK_STATE,
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.connectionsTable = new dynamodb.Table(this, "Connections", {
      tableName: TABLE_NAMES.CONNECTIONS,
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.connectionsTable.addGlobalSecondaryIndex({
      indexName: "userId-index",
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "connectedAt", type: dynamodb.AttributeType.STRING },
    });

    this.pendingMessagesTable = new dynamodb.Table(this, "PendingMessages", {
      tableName: TABLE_NAMES.PENDING_MESSAGES,
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── S3 Buckets ──

    this.dataBucket = new s3.Bucket(this, "DataBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      autoDeleteObjects: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── ECR Repository ──

    this.ecrRepository = new ecr.Repository(this, "EcrRepo", {
      repositoryName: "serverless-openclaw",
      lifecycleRules: [{ maxImageCount: 5 }],
      emptyOnDelete: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── Outputs ──

    new cdk.CfnOutput(this, "ConversationsTableName", {
      value: this.conversationsTable.tableName,
    });
    new cdk.CfnOutput(this, "SettingsTableName", {
      value: this.settingsTable.tableName,
    });
    new cdk.CfnOutput(this, "TaskStateTableName", {
      value: this.taskStateTable.tableName,
    });
    new cdk.CfnOutput(this, "ConnectionsTableName", {
      value: this.connectionsTable.tableName,
    });
    new cdk.CfnOutput(this, "PendingMessagesTableName", {
      value: this.pendingMessagesTable.tableName,
    });
    new cdk.CfnOutput(this, "DataBucketName", {
      value: this.dataBucket.bucketName,
    });
    new cdk.CfnOutput(this, "EcrRepositoryUri", {
      value: this.ecrRepository.repositoryUri,
    });
  }
}

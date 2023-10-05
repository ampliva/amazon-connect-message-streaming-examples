"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatMessageStreamingExamplesStack = void 0;
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
const cdk = require("@aws-cdk/core");
const lambda = require("@aws-cdk/aws-lambda");
const dynamodb = require("@aws-cdk/aws-dynamodb");
const sns = require("@aws-cdk/aws-sns");
const subscriptions = require("@aws-cdk/aws-sns-subscriptions");
const iam = require("@aws-cdk/aws-iam");
const path = require("path");
const apigw2 = require("@aws-cdk/aws-apigatewayv2");
const apigw2i = require("@aws-cdk/aws-apigatewayv2-integrations");
const core_1 = require("@aws-cdk/core");
class ChatMessageStreamingExamplesStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        // The code that defines your stack goes here
        // Need deployment mechanism to check if they are deploying SMS or FB or Both demos and validate on that
        // Get environment variables from context
        const amazonConnectArn = this.node.tryGetContext("amazonConnectArn");
        const contactFlowId = this.node.tryGetContext("contactFlowId");
        const pinpointAppId = this.node.tryGetContext("pinpointAppId");
        const smsNumber = this.node.tryGetContext("smsNumber");
        const fbSecretArn = this.node.tryGetContext("fbSecretArn");
        const waSecretArn = this.node.tryGetContext("waSecretArn");
        const piiRedactionTypes = this.node.tryGetContext("piiRedactionTypes");
        let enableFB = false;
        let enableWhatsApp = false;
        let enableSMS = false;
        let enablePII = false;
        // Validating that environment variables are present 
        if (amazonConnectArn === undefined) {
            throw new Error("Missing amazonConnectArn in the context");
        }
        if (contactFlowId === undefined) {
            throw new Error("Missing Amazon Connect Contact flow Id in the context");
        }
        if (pinpointAppId === undefined && smsNumber === undefined) {
            enableSMS = false;
        }
        else if (pinpointAppId !== undefined && smsNumber === undefined) {
            throw new Error("Missing smsNumber in the context");
        }
        else if (pinpointAppId === undefined && smsNumber !== undefined) {
            throw new Error("Missing pinpointAppId in the context");
        }
        else {
            enableSMS = true;
        }
        if (fbSecretArn != undefined) {
            enableFB = true;
        }
        if (waSecretArn != undefined) {
            enableWhatsApp = true;
        }
        if (piiRedactionTypes != undefined) {
            if (piiRedactionTypes) {
                enablePII = true;
            }
            else {
                throw new Error("piiRedactionTypes cannot be empty, expecting comma separated values of AWS Comprehend PII types");
            }
        }
        if (enableWhatsApp === false && enableFB === false && enableSMS === false) {
            throw new Error("Please enable at least one channel, SMS, Facebook or WhatsApp. You can do so by providing fbSecretArn in the context to enable Facebook, waSecretArn in the context to enable WhatsApp or by providing  pinpointAppId and smsNumber to enable SMS channel");
        }
        const debugLog = new cdk.CfnParameter(this, 'debugLog', {
            allowedValues: ['true', 'false'],
            default: 'false',
            type: 'String',
            description: 'Setting to enable debug level logging in lambda functions.  Recommended to turn this off in production.',
        });
        // pinpoint project will not be in cdk - phone number has to be manually claimed
        // DDB - need GSI
        // Dynamo DB table
        const chatContactDdbTable = new dynamodb.Table(this, 'chatTable', {
            partitionKey: {
                name: 'contactId',
                type: dynamodb.AttributeType.STRING,
            },
            timeToLiveAttribute: 'date',
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        // Dynamo DB table GSI
        // vendorId is phone number or facebook user id
        const vendorIdChannelIndexName = 'vendorId-index';
        chatContactDdbTable.addGlobalSecondaryIndex({
            indexName: vendorIdChannelIndexName,
            partitionKey: {
                name: 'vendorId',
                type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
                name: 'channel',
                type: dynamodb.AttributeType.STRING,
            },
        });
        let smsOutboundMsgStreamingTopic;
        let smsOutboundMsgStreamingTopicStatement;
        if (enableSMS) {
            // outbound SNS topic
            smsOutboundMsgStreamingTopic = new sns.Topic(this, 'smsOutboundMsgStreamingTopic', {});
            smsOutboundMsgStreamingTopicStatement = new iam.PolicyStatement({
                actions: [
                    'sns:Subscribe',
                    'sns:Publish'
                ],
                principals: [new iam.ServicePrincipal('connect.amazonaws.com')],
                resources: [smsOutboundMsgStreamingTopic.topicArn],
            });
            smsOutboundMsgStreamingTopic.addToResourcePolicy(smsOutboundMsgStreamingTopicStatement);
        }
        let digitalOutboundMsgStreamingTopic;
        let digitalOutboundMsgStreamingTopicStatement;
        if (enableFB || enableWhatsApp) {
            digitalOutboundMsgStreamingTopic = new sns.Topic(this, 'digitalOutboundMsgStreamingTopic', {});
            digitalOutboundMsgStreamingTopicStatement = new iam.PolicyStatement({
                actions: [
                    'sns:Subscribe',
                    'sns:Publish'
                ],
                principals: [new iam.ServicePrincipal('connect.amazonaws.com')],
                resources: [digitalOutboundMsgStreamingTopic.topicArn],
            });
            digitalOutboundMsgStreamingTopic.addToResourcePolicy(digitalOutboundMsgStreamingTopicStatement);
        }
        // Inbound Lambda function
        const inboundMessageFunction = new lambda.Function(this, 'inboundMessageFunction', {
            runtime: lambda.Runtime.NODEJS_14_X,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.resolve(__dirname, '../src/lambda/inboundMessageHandler')),
            timeout: core_1.Duration.seconds(120),
            memorySize: 512,
            environment: {
                FB_SECRET: fbSecretArn,
                WA_SECRET: waSecretArn,
                CONTACT_TABLE: chatContactDdbTable.tableName,
                AMAZON_CONNECT_ARN: amazonConnectArn,
                CONTACT_FLOW_ID: contactFlowId,
                DIGITAL_OUTBOUND_SNS_TOPIC: (digitalOutboundMsgStreamingTopic !== undefined ? digitalOutboundMsgStreamingTopic.topicArn : ""),
                SMS_OUTBOUND_SNS_TOPIC: (smsOutboundMsgStreamingTopic !== undefined ? smsOutboundMsgStreamingTopic.topicArn : ""),
                VENDOR_ID_CHANNEL_INDEX_NAME: vendorIdChannelIndexName,
                DEBUG_LOG: debugLog.valueAsString,
                PII_DETECTION_TYPES: (piiRedactionTypes !== undefined ? piiRedactionTypes : "")
            },
        });
        // Inbound SNS topic (for SMS)
        let inboundSMSTopic;
        if (enableSMS) {
            inboundSMSTopic = new sns.Topic(this, 'InboundSMSTopic', {});
            inboundSMSTopic.addSubscription(new subscriptions.LambdaSubscription(inboundMessageFunction));
            new cdk.CfnOutput(this, 'SmsInboundTopic', {
                value: inboundSMSTopic.topicArn.toString(),
            });
        }
        if (enablePII) {
            inboundMessageFunction.addToRolePolicy(new iam.PolicyStatement({
                actions: ['comprehend:DetectPiiEntities'],
                resources: ['*'],
                effect: iam.Effect.ALLOW,
            }));
        }
        if (enableFB) {
            inboundMessageFunction.addToRolePolicy(new iam.PolicyStatement({
                actions: ['secretsmanager:GetSecretValue'],
                resources: [fbSecretArn],
                effect: iam.Effect.ALLOW,
            }));
        }
        if (enableWhatsApp) {
            inboundMessageFunction.addToRolePolicy(new iam.PolicyStatement({
                actions: ['secretsmanager:GetSecretValue'],
                resources: [waSecretArn],
                effect: iam.Effect.ALLOW,
            }));
        }
        inboundMessageFunction.addToRolePolicy(new iam.PolicyStatement({
            actions: ['connect:StartChatContact'],
            resources: [
                `${this.node.tryGetContext("amazonConnectArn")}/contact-flow/${this.node.tryGetContext("contactFlowId")}`,
            ],
            effect: iam.Effect.ALLOW,
        }));
        inboundMessageFunction.addToRolePolicy(new iam.PolicyStatement({
            actions: ['connect:StartContactStreaming'],
            resources: [`${this.node.tryGetContext("amazonConnectArn")}/contact/*`],
            effect: iam.Effect.ALLOW,
        }));
        inboundMessageFunction.addToRolePolicy(new iam.PolicyStatement({
            actions: [
                'dynamodb:PutItem',
                'dynamodb:GetItem',
                'dynamodb:Scan',
                'dynamodb:Query',
                'dynamodb:UpdateItem',
            ],
            resources: [
                chatContactDdbTable.tableArn,
                `${chatContactDdbTable.tableArn}/index/${vendorIdChannelIndexName}`,
            ],
            effect: iam.Effect.ALLOW,
        }));
        // SNS topic filter rules (filter by attribute at the topic level)
        // outbound Lambda function
        const outboundMessageFunction = new lambda.Function(this, 'outboundMessageFunction', {
            runtime: lambda.Runtime.NODEJS_14_X,
            handler: 'index.handler',
            code: lambda.Code.fromAsset(path.resolve(__dirname, '../src/lambda/outboundMessageHandler')),
            timeout: core_1.Duration.seconds(60),
            memorySize: 512,
            environment: {
                CONTACT_TABLE: chatContactDdbTable.tableName,
                PINPOINT_APPLICATION_ID: pinpointAppId,
                FB_SECRET: fbSecretArn,
                WA_SECRET: waSecretArn,
                SMS_NUMBER: smsNumber,
                DEBUG_LOG: debugLog.valueAsString,
            },
        });
        outboundMessageFunction.addToRolePolicy(new iam.PolicyStatement({
            actions: ['mobiletargeting:SendMessages'],
            effect: iam.Effect.ALLOW,
            resources: [
                `arn:aws:mobiletargeting:${this.region}:${this.account}:apps/${this.node.tryGetContext("pinpointAppId")}/messages`,
            ],
        }));
        if (enableFB) {
            outboundMessageFunction.addToRolePolicy(new iam.PolicyStatement({
                actions: ['secretsmanager:GetSecretValue'],
                resources: [fbSecretArn],
                effect: iam.Effect.ALLOW,
            }));
        }
        if (enableWhatsApp) {
            outboundMessageFunction.addToRolePolicy(new iam.PolicyStatement({
                actions: ['secretsmanager:GetSecretValue'],
                resources: [waSecretArn],
                effect: iam.Effect.ALLOW,
            }));
        }
        outboundMessageFunction.addToRolePolicy(new iam.PolicyStatement({
            actions: ['dynamodb:GetItem', 'dynamodb:DeleteItem'],
            resources: [
                chatContactDdbTable.tableArn,
                `${chatContactDdbTable.tableArn}/index/${vendorIdChannelIndexName}`,
            ],
            effect: iam.Effect.ALLOW,
        }));
        // health check Lambda
        let healthCheckFunction;
        let digitalChannelMessageIntegration;
        let digitalChannelHealthCheckIntegration;
        let digitalChannelApi;
        if (enableFB || enableWhatsApp) {
            healthCheckFunction = new lambda.Function(this, 'healthCheckFunction', {
                runtime: lambda.Runtime.NODEJS_14_X,
                handler: 'index.handler',
                code: lambda.Code.fromAsset(path.resolve(__dirname, '../src/lambda/digitalChannelHealthCheck')),
                environment: {
                    DEBUG_LOG: debugLog.valueAsString,
                    FB_SECRET: fbSecretArn,
                    WA_SECRET: waSecretArn,
                },
            });
            if (enableFB) {
                healthCheckFunction.addToRolePolicy(new iam.PolicyStatement({
                    actions: ['secretsmanager:GetSecretValue'],
                    resources: [fbSecretArn],
                    effect: iam.Effect.ALLOW,
                }));
            }
            if (enableWhatsApp) {
                healthCheckFunction.addToRolePolicy(new iam.PolicyStatement({
                    actions: ['secretsmanager:GetSecretValue'],
                    resources: [waSecretArn],
                    effect: iam.Effect.ALLOW,
                }));
            }
            // inbound API Gateway (digital channel)
            digitalChannelMessageIntegration = new apigw2i.HttpLambdaIntegration('inboundMessageFunction', inboundMessageFunction);
            // digitalChannelHealthCheckIntegration = new apigw2i.HttpLambdaIntegration({
            digitalChannelHealthCheckIntegration = new apigw2i.HttpLambdaIntegration('healthCheckFunction', healthCheckFunction);
            digitalChannelApi = new apigw2.HttpApi(this, 'digitalChannelApi', {
                corsPreflight: {
                    allowOrigins: ['*'],
                    allowMethods: [
                        apigw2.CorsHttpMethod.OPTIONS,
                        apigw2.CorsHttpMethod.POST,
                        apigw2.CorsHttpMethod.GET,
                    ],
                    allowHeaders: ['Content-Type'],
                },
            });
            if (enableFB) {
                digitalChannelApi.addRoutes({
                    path: '/webhook/facebook',
                    methods: [apigw2.HttpMethod.POST],
                    integration: digitalChannelMessageIntegration,
                });
                digitalChannelApi.addRoutes({
                    path: '/webhook/facebook',
                    methods: [apigw2.HttpMethod.GET],
                    integration: digitalChannelHealthCheckIntegration,
                });
                new cdk.CfnOutput(this, 'FacebookApiGatewayWebhook', {
                    value: digitalChannelApi.apiEndpoint.toString() + '/webhook/facebook',
                });
            }
            if (enableWhatsApp) {
                digitalChannelApi.addRoutes({
                    path: '/webhook/whatsapp',
                    methods: [apigw2.HttpMethod.POST],
                    integration: digitalChannelMessageIntegration,
                });
                digitalChannelApi.addRoutes({
                    path: '/webhook/whatsapp',
                    methods: [apigw2.HttpMethod.GET],
                    integration: digitalChannelHealthCheckIntegration,
                });
                new cdk.CfnOutput(this, 'WhatsAppApiGatewayWebhook', {
                    value: digitalChannelApi.apiEndpoint.toString() + '/webhook/whatsapp',
                });
            }
            // Outbound lambda subscribe to streaming topic
            if (digitalOutboundMsgStreamingTopic) {
                digitalOutboundMsgStreamingTopic.addSubscription(new subscriptions.LambdaSubscription(outboundMessageFunction, {
                    filterPolicy: {
                        MessageVisibility: sns.SubscriptionFilter.stringFilter({
                            allowlist: ['CUSTOMER', 'ALL'],
                        }),
                    }
                }));
            }
        }
        if (smsOutboundMsgStreamingTopic) {
            smsOutboundMsgStreamingTopic.addSubscription(new subscriptions.LambdaSubscription(outboundMessageFunction, {
                filterPolicy: {
                    MessageVisibility: sns.SubscriptionFilter.stringFilter({
                        allowlist: ['CUSTOMER', 'ALL'],
                    }),
                }
            }));
        }
    }
}
exports.ChatMessageStreamingExamplesStack = ChatMessageStreamingExamplesStack;
// pinpoint project in cdk - phone number has to be manually claimed
// inbound SNS topic (for SMS)
// inbound API Gateway (digital channel)
// inbound Lambda
// DDB -
// outbound SNS topic
// outbound lambda
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2hhdC1tZXNzYWdlLXN0cmVhbWluZy1leGFtcGxlcy1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImNoYXQtbWVzc2FnZS1zdHJlYW1pbmctZXhhbXBsZXMtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUEscUVBQXFFO0FBQ3JFLGlDQUFpQztBQUNqQyxxQ0FBcUM7QUFDckMsOENBQThDO0FBQzlDLGtEQUFrRDtBQUNsRCx3Q0FBd0M7QUFDeEMsZ0VBQWdFO0FBQ2hFLHdDQUF3QztBQUN4Qyw2QkFBNkI7QUFDN0Isb0RBQW9EO0FBQ3BELGtFQUFrRTtBQUNsRSx3Q0FBeUM7QUFFekMsTUFBYSxpQ0FBa0MsU0FBUSxHQUFHLENBQUMsS0FBSztJQUM5RCxZQUFZLEtBQW9CLEVBQUUsRUFBVSxFQUFFLEtBQXNCO1FBQ2xFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLDZDQUE2QztRQUU3Qyx3R0FBd0c7UUFFeEcseUNBQXlDO1FBRXpDLE1BQU0sZ0JBQWdCLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxhQUFhLENBQUMsa0JBQWtCLENBQUMsQ0FBQztRQUNyRSxNQUFNLGFBQWEsR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxlQUFlLENBQUMsQ0FBQztRQUMvRCxNQUFNLGFBQWEsR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxlQUFlLENBQUMsQ0FBQztRQUMvRCxNQUFNLFNBQVMsR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxXQUFXLENBQUMsQ0FBQztRQUN2RCxNQUFNLFdBQVcsR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxhQUFhLENBQUMsQ0FBQztRQUMzRCxNQUFNLFdBQVcsR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxhQUFhLENBQUMsQ0FBQztRQUMzRCxNQUFNLGlCQUFpQixH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SUFBSSxhQUFhLENBQUMsa0JBQWtCLENBQUMsdUJBQXVCLEVBQUU7b0JBQzVELFlBQVksRUFBRTt3QkFDWixpQkFBaUIsRUFBRSxHQUFHLENBQUMsa0JBQWtCLENBQUMsWUFBWSxDQUFDOzRCQUNqRCxTQUFTLEVBQUUsQ0FBQyxVQUFVLEVBQUUsS0FBSyxDQUFDO3lCQUNqQyxDQUFDO3FCQUNMO2lCQUNGLENBQUMsQ0FDSCxDQUFDO2FBQ0g7U0FDRjtRQUVELElBQUcsNEJBQTRCLEVBQUM7WUFDOUIsNEJBQTRCLENBQUMsZUFBZSxDQUMxQyxJQUFJLGFBQWEsQ0FBQyxrQkFBa0IsQ0FBQyx1QkFBdUIsRUFBRTtnQkFDNUQsWUFBWSxFQUFFO29CQUNaLGlCQUFpQixFQUFFLEdBQUcsQ0FBQyxrQkFBa0IsQ0FBQyxZQUFZLENBQUM7d0JBQ2pELFNBQVMsRUFBRSxDQUFDLFVBQVUsRUFBRSxLQUFLLENBQUM7cUJBQ2pDLENBQUM7aUJBQ0w7YUFDRixDQUFDLENBQ0gsQ0FBQztTQUNIO0lBRUgsQ0FBQztDQUNGO0FBcmJELDhFQXFiQztBQUVELG9FQUFvRTtBQUNwRSw4QkFBOEI7QUFDOUIsd0NBQXdDO0FBQ3hDLGlCQUFpQjtBQUNqQixRQUFRO0FBQ1IscUJBQXFCO0FBQ3JCLGtCQUFrQiIsInNvdXJjZXNDb250ZW50IjpbIi8vIENvcHlyaWdodCBBbWF6b24uY29tLCBJbmMuIG9yIGl0cyBhZmZpbGlhdGVzLiBBbGwgUmlnaHRzIFJlc2VydmVkLlxyXG4vLyBTUERYLUxpY2Vuc2UtSWRlbnRpZmllcjogTUlULTBcclxuaW1wb3J0ICogYXMgY2RrIGZyb20gJ0Bhd3MtY2RrL2NvcmUnO1xyXG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSAnQGF3cy1jZGsvYXdzLWxhbWJkYSc7XHJcbmltcG9ydCAqIGFzIGR5bmFtb2RiIGZyb20gJ0Bhd3MtY2RrL2F3cy1keW5hbW9kYic7XHJcbmltcG9ydCAqIGFzIHNucyBmcm9tICdAYXdzLWNkay9hd3Mtc25zJztcclxuaW1wb3J0ICogYXMgc3Vic2NyaXB0aW9ucyBmcm9tICdAYXdzLWNkay9hd3Mtc25zLXN1YnNjcmlwdGlvbnMnO1xyXG5pbXBvcnQgKiBhcyBpYW0gZnJvbSAnQGF3cy1jZGsvYXdzLWlhbSc7XHJcbmltcG9ydCAqIGFzIHBhdGggZnJvbSAncGF0aCc7XHJcbmltcG9ydCAqIGFzIGFwaWd3MiBmcm9tICdAYXdzLWNkay9hd3MtYXBpZ2F0ZXdheXYyJztcclxuaW1wb3J0ICogYXMgYXBpZ3cyaSBmcm9tICdAYXdzLWNkay9hd3MtYXBpZ2F0ZXdheXYyLWludGVncmF0aW9ucyc7XHJcbmltcG9ydCB7IER1cmF0aW9uIH0gZnJvbSAnQGF3cy1jZGsvY29yZSc7XHJcblxyXG5leHBvcnQgY2xhc3MgQ2hhdE1lc3NhZ2VTdHJlYW1pbmdFeGFtcGxlc1N0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcclxuICBjb25zdHJ1Y3RvcihzY29wZTogY2RrLkNvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM/OiBjZGsuU3RhY2tQcm9wcykge1xyXG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XHJcblxyXG4gICAgLy8gVGhlIGNvZGUgdGhhdCBkZWZpbmVzIHlvdXIgc3RhY2sgZ29lcyBoZXJlXHJcblxyXG4gICAgLy8gTmVlZCBkZXBsb3ltZW50IG1lY2hhbmlzbSB0byBjaGVjayBpZiB0aGV5IGFyZSBkZXBsb3lpbmcgU01TIG9yIEZCIG9yIEJvdGggZGVtb3MgYW5kIHZhbGlkYXRlIG9uIHRoYXRcclxuXHJcbiAgICAvLyBHZXQgZW52aXJvbm1lbnQgdmFyaWFibGVzIGZyb20gY29udGV4dFxyXG5cclxuICAgIGNvbnN0IGFtYXpvbkNvbm5lY3RBcm4gPSB0aGlzLm5vZGUudHJ5R2V0Q29udGV4dChcImFtYXpvbkNvbm5lY3RBcm5cIik7XHJcbiAgICBjb25zdCBjb250YWN0Rmxvd0lkID0gdGhpcy5ub2RlLnRyeUdldENvbnRleHQoXCJjb250YWN0Rmxvd0lkXCIpO1xyXG4gICAgY29uc3QgcGlucG9pbnRBcHBJZCA9IHRoaXMubm9kZS50cnlHZXRDb250ZXh0KFwicGlucG9pbnRBcHBJZFwiKTtcclxuICAgIGNvbnN0IHNtc051bWJlciA9IHRoaXMubm9kZS50cnlHZXRDb250ZXh0KFwic21zTnVtYmVyXCIpO1xyXG4gICAgY29uc3QgZmJTZWNyZXRBcm4gPSB0aGlzLm5vZGUudHJ5R2V0Q29udGV4dChcImZiU2VjcmV0QXJuXCIpO1xyXG4gICAgY29uc3Qgd2FTZWNyZXRBcm4gPSB0aGlzLm5vZGUudHJ5R2V0Q29udGV4dChcIndhU2VjcmV0QXJuXCIpO1xyXG4gICAgY29uc3QgcGlpUmVkYWN0aW9uVHlwZXMgPSB0aGlzLm5vZGUudHJ5R2V0Q29udGV4dChcInBpaVJlZGFjdGlvblR5cGVzXCIpO1xyXG4gICAgbGV0IGVuYWJsZUZCID0gZmFsc2U7XHJcbiAgICBsZXQgZW5hYmxlV2hhdHNBcHAgPSBmYWxzZTtcclxuICAgIGxldCBlbmFibGVTTVMgPSBmYWxzZTtcclxuICAgIGxldCBlbmFibGVQSUkgPSBmYWxzZTtcclxuXHJcbiAgICAvLyBWYWxpZGF0aW5nIHRoYXQgZW52aXJvbm1lbnQgdmFyaWFibGVzIGFyZSBwcmVzZW50IFxyXG4gICAgaWYoYW1hem9uQ29ubmVjdEFybiA9PT0gdW5kZWZpbmVkKXtcclxuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiTWlzc2luZyBhbWF6b25Db25uZWN0QXJuIGluIHRoZSBjb250ZXh0XCIpO1xyXG4gICAgfVxyXG5cclxuICAgIGlmKGNvbnRhY3RGbG93SWQgPT09IHVuZGVmaW5lZCl7XHJcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIk1pc3NpbmcgQW1hem9uIENvbm5lY3QgQ29udGFjdCBmbG93IElkIGluIHRoZSBjb250ZXh0XCIpO1xyXG4gICAgfVxyXG5cclxuICAgIGlmKHBpbnBvaW50QXBwSWQgPT09IHVuZGVmaW5lZCAmJiBzbXNOdW1iZXIgPT09IHVuZGVmaW5lZCl7XHJcbiAgICAgIGVuYWJsZVNNUyA9IGZhbHNlO1xyXG4gICAgfSBlbHNlIGlmIChwaW5wb2ludEFwcElkICE9PSB1bmRlZmluZWQgJiYgc21zTnVtYmVyID09PSB1bmRlZmluZWQpe1xyXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJNaXNzaW5nIHNtc051bWJlciBpbiB0aGUgY29udGV4dFwiKTtcclxuICAgIH0gZWxzZSBpZiAocGlucG9pbnRBcHBJZCA9PT0gdW5kZWZpbmVkICYmIHNtc051bWJlciAhPT0gdW5kZWZpbmVkKXtcclxuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiTWlzc2luZyBwaW5wb2ludEFwcElkIGluIHRoZSBjb250ZXh0XCIpO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgZW5hYmxlU01TID0gdHJ1ZTtcclxuICAgIH1cclxuXHJcbiAgICBpZihmYlNlY3JldEFybiAhPSB1bmRlZmluZWQpe1xyXG4gICAgICBlbmFibGVGQiA9IHRydWU7XHJcbiAgICB9XHJcblxyXG4gICAgaWYod2FTZWNyZXRBcm4gIT0gdW5kZWZpbmVkKXtcclxuICAgICAgZW5hYmxlV2hhdHNBcHAgPSB0cnVlO1xyXG4gICAgfVxyXG5cclxuICAgIGlmKHBpaVJlZGFjdGlvblR5cGVzICE9IHVuZGVmaW5lZCl7XHJcbiAgICAgIGlmIChwaWlSZWRhY3Rpb25UeXBlcykge1xyXG4gICAgICAgIGVuYWJsZVBJSSA9IHRydWU7XHJcbiAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwicGlpUmVkYWN0aW9uVHlwZXMgY2Fubm90IGJlIGVtcHR5LCBleHBlY3RpbmcgY29tbWEgc2VwYXJhdGVkIHZhbHVlcyBvZiBBV1MgQ29tcHJlaGVuZCBQSUkgdHlwZXNcIik7XHJcbiAgICAgIH1cclxuICAgIH1cclxuICBcclxuXHJcbiAgICBpZihlbmFibGVXaGF0c0FwcCA9PT0gZmFsc2UgJiYgZW5hYmxlRkIgPT09IGZhbHNlICYmIGVuYWJsZVNNUyA9PT0gZmFsc2Upe1xyXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJQbGVhc2UgZW5hYmxlIGF0IGxlYXN0IG9uZSBjaGFubmVsLCBTTVMsIEZhY2Vib29rIG9yIFdoYXRzQXBwLiBZb3UgY2FuIGRvIHNvIGJ5IHByb3ZpZGluZyBmYlNlY3JldEFybiBpbiB0aGUgY29udGV4dCB0byBlbmFibGUgRmFjZWJvb2ssIHdhU2VjcmV0QXJuIGluIHRoZSBjb250ZXh0IHRvIGVuYWJsZSBXaGF0c0FwcCBvciBieSBwcm92aWRpbmcgIHBpbnBvaW50QXBwSWQgYW5kIHNtc051bWJlciB0byBlbmFibGUgU01TIGNoYW5uZWxcIik7XHJcbiAgICB9XHJcblxyXG4gICAgY29uc3QgZGVidWdMb2cgPSBuZXcgY2RrLkNmblBhcmFtZXRlcih0aGlzLCAnZGVidWdMb2cnLCB7XHJcbiAgICAgIGFsbG93ZWRWYWx1ZXM6IFsndHJ1ZScsICdmYWxzZSddLFxyXG4gICAgICBkZWZhdWx0OiAnZmFsc2UnLFxyXG4gICAgICB0eXBlOiAnU3RyaW5nJyxcclxuICAgICAgZGVzY3JpcHRpb246XHJcbiAgICAgICAgJ1NldHRpbmcgdG8gZW5hYmxlIGRlYnVnIGxldmVsIGxvZ2dpbmcgaW4gbGFtYmRhIGZ1bmN0aW9ucy4gIFJlY29tbWVuZGVkIHRvIHR1cm4gdGhpcyBvZmYgaW4gcHJvZHVjdGlvbi4nLFxyXG4gICAgfSk7XHJcblxyXG4gICAgLy8gcGlucG9pbnQgcHJvamVjdCB3aWxsIG5vdCBiZSBpbiBjZGsgLSBwaG9uZSBudW1iZXIgaGFzIHRvIGJlIG1hbnVhbGx5IGNsYWltZWRcclxuXHJcbiAgICAvLyBEREIgLSBuZWVkIEdTSVxyXG5cclxuICAgIC8vIER5bmFtbyBEQiB0YWJsZVxyXG5cclxuICAgIGNvbnN0IGNoYXRDb250YWN0RGRiVGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgJ2NoYXRUYWJsZScsIHtcclxuICAgICAgcGFydGl0aW9uS2V5OiB7XHJcbiAgICAgICAgbmFtZTogJ2NvbnRhY3RJZCcsXHJcbiAgICAgICAgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcsXHJcbiAgICAgIH0sXHJcbiAgICAgIHRpbWVUb0xpdmVBdHRyaWJ1dGU6ICdkYXRlJyxcclxuICAgICAgYmlsbGluZ01vZGU6IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVCxcclxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcclxuICAgIH0pO1xyXG5cclxuICAgIC8vIER5bmFtbyBEQiB0YWJsZSBHU0lcclxuICAgIC8vIHZlbmRvcklkIGlzIHBob25lIG51bWJlciBvciBmYWNlYm9vayB1c2VyIGlkXHJcblxyXG4gICAgY29uc3QgdmVuZG9ySWRDaGFubmVsSW5kZXhOYW1lID0gJ3ZlbmRvcklkLWluZGV4JztcclxuICAgIGNoYXRDb250YWN0RGRiVGFibGUuYWRkR2xvYmFsU2Vjb25kYXJ5SW5kZXgoe1xyXG4gICAgICBpbmRleE5hbWU6IHZlbmRvcklkQ2hhbm5lbEluZGV4TmFtZSxcclxuICAgICAgcGFydGl0aW9uS2V5OiB7XHJcbiAgICAgICAgbmFtZTogJ3ZlbmRvcklkJyxcclxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyxcclxuICAgICAgfSxcclxuICAgICAgc29ydEtleToge1xyXG4gICAgICAgIG5hbWU6ICdjaGFubmVsJyxcclxuICAgICAgICB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyxcclxuICAgICAgfSxcclxuICAgIH0pO1xyXG5cclxuICAgIGxldCBzbXNPdXRib3VuZE1zZ1N0cmVhbWluZ1RvcGljO1xyXG4gICAgbGV0IHNtc091dGJvdW5kTXNnU3RyZWFtaW5nVG9waWNTdGF0ZW1lbnQ7XHJcblxyXG4gICAgaWYoZW5hYmxlU01TKXtcclxuICAgICAgLy8gb3V0Ym91bmQgU05TIHRvcGljXHJcbiAgICAgIHNtc091dGJvdW5kTXNnU3RyZWFtaW5nVG9waWMgPSBuZXcgc25zLlRvcGljKFxyXG4gICAgICAgIHRoaXMsXHJcbiAgICAgICAgJ3Ntc091dGJvdW5kTXNnU3RyZWFtaW5nVG9waWMnLFxyXG4gICAgICAgIHt9XHJcbiAgICAgICk7XHJcblxyXG4gICAgICBzbXNPdXRib3VuZE1zZ1N0cmVhbWluZ1RvcGljU3RhdGVtZW50ID0gbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICAgIGFjdGlvbnM6IFtcclxuICAgICAgICAgICdzbnM6U3Vic2NyaWJlJywgXHJcbiAgICAgICAgICAnc25zOlB1Ymxpc2gnXHJcbiAgICAgICAgXSxcclxuICAgICAgICBwcmluY2lwYWxzOiBbbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdjb25uZWN0LmFtYXpvbmF3cy5jb20nKV0sXHJcbiAgICAgICAgcmVzb3VyY2VzOiBbc21zT3V0Ym91bmRNc2dTdHJlYW1pbmdUb3BpYy50b3BpY0Fybl0sXHJcbiAgICAgIH0pO1xyXG5cclxuICAgICAgc21zT3V0Ym91bmRNc2dTdHJlYW1pbmdUb3BpYy5hZGRUb1Jlc291cmNlUG9saWN5KHNtc091dGJvdW5kTXNnU3RyZWFtaW5nVG9waWNTdGF0ZW1lbnQpXHJcbiAgICB9XHJcblxyXG5cclxuICAgIGxldCBkaWdpdGFsT3V0Ym91bmRNc2dTdHJlYW1pbmdUb3BpYztcclxuICAgIGxldCBkaWdpdGFsT3V0Ym91bmRNc2dTdHJlYW1pbmdUb3BpY1N0YXRlbWVudDtcclxuXHJcbiAgICBpZihlbmFibGVGQiB8fCBlbmFibGVXaGF0c0FwcCl7XHJcbiAgICAgIGRpZ2l0YWxPdXRib3VuZE1zZ1N0cmVhbWluZ1RvcGljID0gbmV3IHNucy5Ub3BpYyhcclxuICAgICAgICB0aGlzLFxyXG4gICAgICAgICdkaWdpdGFsT3V0Ym91bmRNc2dTdHJlYW1pbmdUb3BpYycsXHJcbiAgICAgICAge31cclxuICAgICAgKTtcclxuICBcclxuICAgICAgZGlnaXRhbE91dGJvdW5kTXNnU3RyZWFtaW5nVG9waWNTdGF0ZW1lbnQgPSBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XHJcbiAgICAgICAgYWN0aW9uczogW1xyXG4gICAgICAgICAgJ3NuczpTdWJzY3JpYmUnLFxyXG4gICAgICAgICAgJ3NuczpQdWJsaXNoJ1xyXG4gICAgICAgIF0sXHJcbiAgICAgICAgcHJpbmNpcGFsczogW25ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnY29ubmVjdC5hbWF6b25hd3MuY29tJyldLFxyXG4gICAgICAgIHJlc291cmNlczogW2RpZ2l0YWxPdXRib3VuZE1zZ1N0cmVhbWluZ1RvcGljLnRvcGljQXJuXSxcclxuICAgICAgfSk7XHJcbiAgXHJcbiAgICAgIGRpZ2l0YWxPdXRib3VuZE1zZ1N0cmVhbWluZ1RvcGljLmFkZFRvUmVzb3VyY2VQb2xpY3koZGlnaXRhbE91dGJvdW5kTXNnU3RyZWFtaW5nVG9waWNTdGF0ZW1lbnQpO1xyXG4gICAgfVxyXG4gICAgXHJcbiAgICBcclxuICAgIC8vIEluYm91bmQgTGFtYmRhIGZ1bmN0aW9uXHJcbiAgICBjb25zdCBpbmJvdW5kTWVzc2FnZUZ1bmN0aW9uID0gbmV3IGxhbWJkYS5GdW5jdGlvbihcclxuICAgICAgdGhpcyxcclxuICAgICAgJ2luYm91bmRNZXNzYWdlRnVuY3Rpb24nLFxyXG4gICAgICB7XHJcbiAgICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzE0X1gsXHJcbiAgICAgICAgaGFuZGxlcjogJ2luZGV4LmhhbmRsZXInLFxyXG4gICAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldChcclxuICAgICAgICAgIHBhdGgucmVzb2x2ZShfX2Rpcm5hbWUsICcuLi9zcmMvbGFtYmRhL2luYm91bmRNZXNzYWdlSGFuZGxlcicpXHJcbiAgICAgICAgKSxcclxuICAgICAgICB0aW1lb3V0OiBEdXJhdGlvbi5zZWNvbmRzKDEyMCksXHJcbiAgICAgICAgbWVtb3J5U2l6ZTogNTEyLFxyXG4gICAgICAgIGVudmlyb25tZW50OiB7XHJcbiAgICAgICAgICBGQl9TRUNSRVQ6IGZiU2VjcmV0QXJuLFxyXG4gICAgICAgICAgV0FfU0VDUkVUOiB3YVNlY3JldEFybixcclxuICAgICAgICAgIENPTlRBQ1RfVEFCTEU6IGNoYXRDb250YWN0RGRiVGFibGUudGFibGVOYW1lLFxyXG4gICAgICAgICAgQU1BWk9OX0NPTk5FQ1RfQVJOOiBhbWF6b25Db25uZWN0QXJuLFxyXG4gICAgICAgICAgQ09OVEFDVF9GTE9XX0lEOiBjb250YWN0Rmxvd0lkLFxyXG4gICAgICAgICAgRElHSVRBTF9PVVRCT1VORF9TTlNfVE9QSUM6IChkaWdpdGFsT3V0Ym91bmRNc2dTdHJlYW1pbmdUb3BpYyAhPT0gdW5kZWZpbmVkID8gZGlnaXRhbE91dGJvdW5kTXNnU3RyZWFtaW5nVG9waWMudG9waWNBcm4gOiBcIlwiICksXHJcbiAgICAgICAgICBTTVNfT1VUQk9VTkRfU05TX1RPUElDOiAoc21zT3V0Ym91bmRNc2dTdHJlYW1pbmdUb3BpYyAhPT0gdW5kZWZpbmVkID8gc21zT3V0Ym91bmRNc2dTdHJlYW1pbmdUb3BpYy50b3BpY0FybiA6IFwiXCIgKSxcclxuICAgICAgICAgIFZFTkRPUl9JRF9DSEFOTkVMX0lOREVYX05BTUU6IHZlbmRvcklkQ2hhbm5lbEluZGV4TmFtZSxcclxuICAgICAgICAgIERFQlVHX0xPRzogZGVidWdMb2cudmFsdWVBc1N0cmluZyxcclxuICAgICAgICAgIFBJSV9ERVRFQ1RJT05fVFlQRVM6IChwaWlSZWRhY3Rpb25UeXBlcyAhPT0gdW5kZWZpbmVkID8gcGlpUmVkYWN0aW9uVHlwZXMgOiBcIlwiIClcclxuICAgICAgICB9LFxyXG4gICAgICB9XHJcbiAgICApO1xyXG5cclxuICAgIC8vIEluYm91bmQgU05TIHRvcGljIChmb3IgU01TKVxyXG4gICAgbGV0IGluYm91bmRTTVNUb3BpYzogc25zLlRvcGljO1xyXG5cclxuICAgIGlmKGVuYWJsZVNNUyl7XHJcbiAgICAgIGluYm91bmRTTVNUb3BpYyA9IG5ldyBzbnMuVG9waWModGhpcywgJ0luYm91bmRTTVNUb3BpYycsIHt9KTsgIFxyXG4gICAgICBpbmJvdW5kU01TVG9waWMuYWRkU3Vic2NyaXB0aW9uKFxyXG4gICAgICAgIG5ldyBzdWJzY3JpcHRpb25zLkxhbWJkYVN1YnNjcmlwdGlvbihpbmJvdW5kTWVzc2FnZUZ1bmN0aW9uKVxyXG4gICAgICApO1xyXG4gICAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnU21zSW5ib3VuZFRvcGljJywge1xyXG4gICAgICAgIHZhbHVlOiBpbmJvdW5kU01TVG9waWMudG9waWNBcm4udG9TdHJpbmcoKSxcclxuICAgICAgfSk7IFxyXG4gICAgfVxyXG5cclxuICAgIGlmKGVuYWJsZVBJSSl7XHJcbiAgICAgIGluYm91bmRNZXNzYWdlRnVuY3Rpb24uYWRkVG9Sb2xlUG9saWN5KFxyXG4gICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgICAgIGFjdGlvbnM6IFsnY29tcHJlaGVuZDpEZXRlY3RQaWlFbnRpdGllcyddLFxyXG4gICAgICAgICAgcmVzb3VyY2VzOiBbJyonXSxcclxuICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcclxuICAgICAgICB9KVxyXG4gICAgICApO1xyXG4gICAgfVxyXG5cclxuICAgIGlmKGVuYWJsZUZCKXtcclxuICAgICAgaW5ib3VuZE1lc3NhZ2VGdW5jdGlvbi5hZGRUb1JvbGVQb2xpY3koXHJcbiAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICAgICAgYWN0aW9uczogWydzZWNyZXRzbWFuYWdlcjpHZXRTZWNyZXRWYWx1ZSddLFxyXG4gICAgICAgICAgcmVzb3VyY2VzOiBbZmJTZWNyZXRBcm5dLFxyXG4gICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxyXG4gICAgICAgIH0pXHJcbiAgICAgICk7XHJcbiAgICB9XHJcbiAgICBpZihlbmFibGVXaGF0c0FwcCl7XHJcbiAgICAgIGluYm91bmRNZXNzYWdlRnVuY3Rpb24uYWRkVG9Sb2xlUG9saWN5KFxyXG4gICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgICAgIGFjdGlvbnM6IFsnc2VjcmV0c21hbmFnZXI6R2V0U2VjcmV0VmFsdWUnXSxcclxuICAgICAgICAgIHJlc291cmNlczogW3dhU2VjcmV0QXJuXSxcclxuICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcclxuICAgICAgICB9KVxyXG4gICAgICApO1xyXG4gICAgfVxyXG5cclxuXHJcbiAgICBpbmJvdW5kTWVzc2FnZUZ1bmN0aW9uLmFkZFRvUm9sZVBvbGljeShcclxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICAgIGFjdGlvbnM6IFsnY29ubmVjdDpTdGFydENoYXRDb250YWN0J10sXHJcbiAgICAgICAgcmVzb3VyY2VzOiBbXHJcbiAgICAgICAgICBgJHt0aGlzLm5vZGUudHJ5R2V0Q29udGV4dChcImFtYXpvbkNvbm5lY3RBcm5cIil9L2NvbnRhY3QtZmxvdy8ke3RoaXMubm9kZS50cnlHZXRDb250ZXh0KFwiY29udGFjdEZsb3dJZFwiKX1gLFxyXG4gICAgICAgIF0sXHJcbiAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxyXG4gICAgICB9KVxyXG4gICAgKTtcclxuXHJcbiAgICBpbmJvdW5kTWVzc2FnZUZ1bmN0aW9uLmFkZFRvUm9sZVBvbGljeShcclxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICAgIGFjdGlvbnM6IFsnY29ubmVjdDpTdGFydENvbnRhY3RTdHJlYW1pbmcnXSxcclxuICAgICAgICByZXNvdXJjZXM6IFtgJHt0aGlzLm5vZGUudHJ5R2V0Q29udGV4dChcImFtYXpvbkNvbm5lY3RBcm5cIil9L2NvbnRhY3QvKmBdLFxyXG4gICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcclxuICAgICAgfSlcclxuICAgICk7XHJcblxyXG4gICAgaW5ib3VuZE1lc3NhZ2VGdW5jdGlvbi5hZGRUb1JvbGVQb2xpY3koXHJcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgICBhY3Rpb25zOiBbXHJcbiAgICAgICAgICAnZHluYW1vZGI6UHV0SXRlbScsXHJcbiAgICAgICAgICAnZHluYW1vZGI6R2V0SXRlbScsXHJcbiAgICAgICAgICAnZHluYW1vZGI6U2NhbicsXHJcbiAgICAgICAgICAnZHluYW1vZGI6UXVlcnknLFxyXG4gICAgICAgICAgJ2R5bmFtb2RiOlVwZGF0ZUl0ZW0nLFxyXG4gICAgICAgIF0sXHJcbiAgICAgICAgcmVzb3VyY2VzOiBbXHJcbiAgICAgICAgICBjaGF0Q29udGFjdERkYlRhYmxlLnRhYmxlQXJuLFxyXG4gICAgICAgICAgYCR7Y2hhdENvbnRhY3REZGJUYWJsZS50YWJsZUFybn0vaW5kZXgvJHt2ZW5kb3JJZENoYW5uZWxJbmRleE5hbWV9YCxcclxuICAgICAgICBdLFxyXG4gICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcclxuICAgICAgfSlcclxuICAgICk7XHJcblxyXG4gICAgLy8gU05TIHRvcGljIGZpbHRlciBydWxlcyAoZmlsdGVyIGJ5IGF0dHJpYnV0ZSBhdCB0aGUgdG9waWMgbGV2ZWwpXHJcbiAgICAvLyBvdXRib3VuZCBMYW1iZGEgZnVuY3Rpb25cclxuICAgIGNvbnN0IG91dGJvdW5kTWVzc2FnZUZ1bmN0aW9uID0gbmV3IGxhbWJkYS5GdW5jdGlvbihcclxuICAgICAgdGhpcyxcclxuICAgICAgJ291dGJvdW5kTWVzc2FnZUZ1bmN0aW9uJyxcclxuICAgICAge1xyXG4gICAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18xNF9YLFxyXG4gICAgICAgIGhhbmRsZXI6ICdpbmRleC5oYW5kbGVyJyxcclxuICAgICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQoXHJcbiAgICAgICAgICBwYXRoLnJlc29sdmUoX19kaXJuYW1lLCAnLi4vc3JjL2xhbWJkYS9vdXRib3VuZE1lc3NhZ2VIYW5kbGVyJylcclxuICAgICAgICApLFxyXG4gICAgICAgIHRpbWVvdXQ6IER1cmF0aW9uLnNlY29uZHMoNjApLFxyXG4gICAgICAgIG1lbW9yeVNpemU6IDUxMixcclxuICAgICAgICBlbnZpcm9ubWVudDoge1xyXG4gICAgICAgICAgQ09OVEFDVF9UQUJMRTogY2hhdENvbnRhY3REZGJUYWJsZS50YWJsZU5hbWUsXHJcbiAgICAgICAgICBQSU5QT0lOVF9BUFBMSUNBVElPTl9JRDogcGlucG9pbnRBcHBJZCxcclxuICAgICAgICAgIEZCX1NFQ1JFVDogZmJTZWNyZXRBcm4sXHJcbiAgICAgICAgICBXQV9TRUNSRVQ6IHdhU2VjcmV0QXJuLFxyXG4gICAgICAgICAgU01TX05VTUJFUjogc21zTnVtYmVyLFxyXG4gICAgICAgICAgREVCVUdfTE9HOiBkZWJ1Z0xvZy52YWx1ZUFzU3RyaW5nLFxyXG4gICAgICAgIH0sXHJcbiAgICAgIH1cclxuICAgICk7XHJcblxyXG4gICAgb3V0Ym91bmRNZXNzYWdlRnVuY3Rpb24uYWRkVG9Sb2xlUG9saWN5KFxyXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XHJcbiAgICAgICAgYWN0aW9uczogWydtb2JpbGV0YXJnZXRpbmc6U2VuZE1lc3NhZ2VzJ10sXHJcbiAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxyXG4gICAgICAgIHJlc291cmNlczogW1xyXG4gICAgICAgICAgYGFybjphd3M6bW9iaWxldGFyZ2V0aW5nOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTphcHBzLyR7dGhpcy5ub2RlLnRyeUdldENvbnRleHQoXCJwaW5wb2ludEFwcElkXCIpfS9tZXNzYWdlc2AsXHJcbiAgICAgICAgXSxcclxuICAgICAgfSlcclxuICAgICk7XHJcblxyXG4gICAgaWYoZW5hYmxlRkIpe1xyXG4gICAgICBvdXRib3VuZE1lc3NhZ2VGdW5jdGlvbi5hZGRUb1JvbGVQb2xpY3koXHJcbiAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xyXG4gICAgICAgICAgYWN0aW9uczogWydzZWNyZXRzbWFuYWdlcjpHZXRTZWNyZXRWYWx1ZSddLFxyXG4gICAgICAgICAgcmVzb3VyY2VzOiBbZmJTZWNyZXRBcm5dLFxyXG4gICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxyXG4gICAgICAgIH0pXHJcbiAgICAgICk7XHJcbiAgICB9XHJcbiAgICBpZihlbmFibGVXaGF0c0FwcCl7XHJcbiAgICAgIG91dGJvdW5kTWVzc2FnZUZ1bmN0aW9uLmFkZFRvUm9sZVBvbGljeShcclxuICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XHJcbiAgICAgICAgICBhY3Rpb25zOiBbJ3NlY3JldHNtYW5hZ2VyOkdldFNlY3JldFZhbHVlJ10sXHJcbiAgICAgICAgICByZXNvdXJjZXM6IFt3YVNlY3JldEFybl0sXHJcbiAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXHJcbiAgICAgICAgfSlcclxuICAgICAgKTtcclxuICAgIH1cclxuXHJcbiAgICBvdXRib3VuZE1lc3NhZ2VGdW5jdGlvbi5hZGRUb1JvbGVQb2xpY3koXHJcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgICBhY3Rpb25zOiBbJ2R5bmFtb2RiOkdldEl0ZW0nLCAnZHluYW1vZGI6RGVsZXRlSXRlbSddLFxyXG4gICAgICAgIHJlc291cmNlczogW1xyXG4gICAgICAgICAgY2hhdENvbnRhY3REZGJUYWJsZS50YWJsZUFybixcclxuICAgICAgICAgIGAke2NoYXRDb250YWN0RGRiVGFibGUudGFibGVBcm59L2luZGV4LyR7dmVuZG9ySWRDaGFubmVsSW5kZXhOYW1lfWAsXHJcbiAgICAgICAgXSxcclxuICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXHJcbiAgICAgIH0pXHJcbiAgICApO1xyXG5cclxuICAgIC8vIGhlYWx0aCBjaGVjayBMYW1iZGFcclxuICAgIGxldCBoZWFsdGhDaGVja0Z1bmN0aW9uOiBsYW1iZGEuRnVuY3Rpb247XHJcbiAgICBsZXQgZGlnaXRhbENoYW5uZWxNZXNzYWdlSW50ZWdyYXRpb246IGFwaWd3MmkuSHR0cExhbWJkYUludGVncmF0aW9uO1xyXG4gICAgbGV0IGRpZ2l0YWxDaGFubmVsSGVhbHRoQ2hlY2tJbnRlZ3JhdGlvbjogYXBpZ3cyaS5IdHRwTGFtYmRhSW50ZWdyYXRpb247XHJcbiAgICBsZXQgZGlnaXRhbENoYW5uZWxBcGk7XHJcblxyXG4gICAgaWYoZW5hYmxlRkIgfHwgZW5hYmxlV2hhdHNBcHApe1xyXG4gICAgICBoZWFsdGhDaGVja0Z1bmN0aW9uID0gbmV3IGxhbWJkYS5GdW5jdGlvbihcclxuICAgICAgICB0aGlzLFxyXG4gICAgICAgICdoZWFsdGhDaGVja0Z1bmN0aW9uJyxcclxuICAgICAgICB7XHJcbiAgICAgICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMTRfWCxcclxuICAgICAgICAgIGhhbmRsZXI6ICdpbmRleC5oYW5kbGVyJyxcclxuICAgICAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldChcclxuICAgICAgICAgICAgcGF0aC5yZXNvbHZlKF9fZGlybmFtZSwgJy4uL3NyYy9sYW1iZGEvZGlnaXRhbENoYW5uZWxIZWFsdGhDaGVjaycpXHJcbiAgICAgICAgICApLFxyXG4gICAgICAgICAgZW52aXJvbm1lbnQ6IHtcclxuICAgICAgICAgICAgREVCVUdfTE9HOiBkZWJ1Z0xvZy52YWx1ZUFzU3RyaW5nLFxyXG4gICAgICAgICAgICBGQl9TRUNSRVQ6IGZiU2VjcmV0QXJuLFxyXG4gICAgICAgICAgICBXQV9TRUNSRVQ6IHdhU2VjcmV0QXJuLFxyXG4gICAgICAgICAgfSxcclxuICAgICAgICB9XHJcbiAgICAgICk7XHJcbiAgICAgIGlmKGVuYWJsZUZCKXtcclxuICAgICAgICBoZWFsdGhDaGVja0Z1bmN0aW9uLmFkZFRvUm9sZVBvbGljeShcclxuICAgICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcclxuICAgICAgICAgICAgYWN0aW9uczogWydzZWNyZXRzbWFuYWdlcjpHZXRTZWNyZXRWYWx1ZSddLFxyXG4gICAgICAgICAgICByZXNvdXJjZXM6IFtmYlNlY3JldEFybl0sXHJcbiAgICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcclxuICAgICAgICAgIH0pXHJcbiAgICAgICAgKTtcclxuICAgICAgfVxyXG4gICAgICBpZihlbmFibGVXaGF0c0FwcCl7XHJcbiAgICAgICAgaGVhbHRoQ2hlY2tGdW5jdGlvbi5hZGRUb1JvbGVQb2xpY3koXHJcbiAgICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XHJcbiAgICAgICAgICAgIGFjdGlvbnM6IFsnc2VjcmV0c21hbmFnZXI6R2V0U2VjcmV0VmFsdWUnXSxcclxuICAgICAgICAgICAgcmVzb3VyY2VzOiBbd2FTZWNyZXRBcm5dLFxyXG4gICAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXHJcbiAgICAgICAgICB9KVxyXG4gICAgICAgICk7XHJcbiAgICAgIH1cclxuICAgICAgLy8gaW5ib3VuZCBBUEkgR2F0ZXdheSAoZGlnaXRhbCBjaGFubmVsKVxyXG4gICAgICBkaWdpdGFsQ2hhbm5lbE1lc3NhZ2VJbnRlZ3JhdGlvbiA9IG5ldyBhcGlndzJpLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbihcclxuICAgICAgICAnaW5ib3VuZE1lc3NhZ2VGdW5jdGlvbicsIGluYm91bmRNZXNzYWdlRnVuY3Rpb24pO1xyXG4gICAgICBcclxuICAgICAgLy8gZGlnaXRhbENoYW5uZWxIZWFsdGhDaGVja0ludGVncmF0aW9uID0gbmV3IGFwaWd3MmkuSHR0cExhbWJkYUludGVncmF0aW9uKHtcclxuICAgICAgZGlnaXRhbENoYW5uZWxIZWFsdGhDaGVja0ludGVncmF0aW9uID0gbmV3IGFwaWd3MmkuSHR0cExhbWJkYUludGVncmF0aW9uKFxyXG4gICAgICAgICdoZWFsdGhDaGVja0Z1bmN0aW9uJywgaGVhbHRoQ2hlY2tGdW5jdGlvbik7XHJcblxyXG4gICAgICBkaWdpdGFsQ2hhbm5lbEFwaSA9IG5ldyBhcGlndzIuSHR0cEFwaSh0aGlzLCAnZGlnaXRhbENoYW5uZWxBcGknLCB7XHJcbiAgICAgICAgY29yc1ByZWZsaWdodDoge1xyXG4gICAgICAgICAgYWxsb3dPcmlnaW5zOiBbJyonXSxcclxuICAgICAgICAgIGFsbG93TWV0aG9kczogW1xyXG4gICAgICAgICAgICBhcGlndzIuQ29yc0h0dHBNZXRob2QuT1BUSU9OUyxcclxuICAgICAgICAgICAgYXBpZ3cyLkNvcnNIdHRwTWV0aG9kLlBPU1QsXHJcbiAgICAgICAgICAgIGFwaWd3Mi5Db3JzSHR0cE1ldGhvZC5HRVQsXHJcbiAgICAgICAgICBdLFxyXG4gICAgICAgICAgYWxsb3dIZWFkZXJzOiBbJ0NvbnRlbnQtVHlwZSddLFxyXG4gICAgICAgIH0sXHJcbiAgICAgIH0pO1xyXG4gICAgICBpZihlbmFibGVGQil7XHJcbiAgICAgICAgZGlnaXRhbENoYW5uZWxBcGkuYWRkUm91dGVzKHtcclxuICAgICAgICAgIHBhdGg6ICcvd2ViaG9vay9mYWNlYm9vaycsXHJcbiAgICAgICAgICBtZXRob2RzOiBbYXBpZ3cyLkh0dHBNZXRob2QuUE9TVF0sXHJcbiAgICAgICAgICBpbnRlZ3JhdGlvbjogZGlnaXRhbENoYW5uZWxNZXNzYWdlSW50ZWdyYXRpb24sXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgZGlnaXRhbENoYW5uZWxBcGkuYWRkUm91dGVzKHtcclxuICAgICAgICAgIHBhdGg6ICcvd2ViaG9vay9mYWNlYm9vaycsXHJcbiAgICAgICAgICBtZXRob2RzOiBbYXBpZ3cyLkh0dHBNZXRob2QuR0VUXSxcclxuICAgICAgICAgIGludGVncmF0aW9uOiBkaWdpdGFsQ2hhbm5lbEhlYWx0aENoZWNrSW50ZWdyYXRpb24sXHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0ZhY2Vib29rQXBpR2F0ZXdheVdlYmhvb2snLCB7XHJcbiAgICAgICAgICB2YWx1ZTogZGlnaXRhbENoYW5uZWxBcGkuYXBpRW5kcG9pbnQudG9TdHJpbmcoKSArICcvd2ViaG9vay9mYWNlYm9vaycsXHJcbiAgICAgICAgfSk7XHJcbiAgICAgIH1cclxuXHJcbiAgICAgIGlmKGVuYWJsZVdoYXRzQXBwKXtcclxuICAgICAgICBkaWdpdGFsQ2hhbm5lbEFwaS5hZGRSb3V0ZXMoe1xyXG4gICAgICAgICAgcGF0aDogJy93ZWJob29rL3doYXRzYXBwJyxcclxuICAgICAgICAgIG1ldGhvZHM6IFthcGlndzIuSHR0cE1ldGhvZC5QT1NUXSxcclxuICAgICAgICAgIGludGVncmF0aW9uOiBkaWdpdGFsQ2hhbm5lbE1lc3NhZ2VJbnRlZ3JhdGlvbixcclxuICAgICAgICB9KTtcclxuICAgICAgICBkaWdpdGFsQ2hhbm5lbEFwaS5hZGRSb3V0ZXMoe1xyXG4gICAgICAgICAgcGF0aDogJy93ZWJob29rL3doYXRzYXBwJyxcclxuICAgICAgICAgIG1ldGhvZHM6IFthcGlndzIuSHR0cE1ldGhvZC5HRVRdLFxyXG4gICAgICAgICAgaW50ZWdyYXRpb246IGRpZ2l0YWxDaGFubmVsSGVhbHRoQ2hlY2tJbnRlZ3JhdGlvbixcclxuICAgICAgICB9KTtcclxuICAgICAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnV2hhdHNBcHBBcGlHYXRld2F5V2ViaG9vaycsIHtcclxuICAgICAgICAgIHZhbHVlOiBkaWdpdGFsQ2hhbm5lbEFwaS5hcGlFbmRwb2ludC50b1N0cmluZygpICsgJy93ZWJob29rL3doYXRzYXBwJyxcclxuICAgICAgICB9KTtcclxuICAgICAgfVxyXG5cclxuICAgICAgLy8gT3V0Ym91bmQgbGFtYmRhIHN1YnNjcmliZSB0byBzdHJlYW1pbmcgdG9waWNcclxuICAgICAgaWYoZGlnaXRhbE91dGJvdW5kTXNnU3RyZWFtaW5nVG9waWMpe1xyXG4gICAgICAgIGRpZ2l0YWxPdXRib3VuZE1zZ1N0cmVhbWluZ1RvcGljLmFkZFN1YnNjcmlwdGlvbihcclxuICAgICAgICAgIG5ldyBzdWJzY3JpcHRpb25zLkxhbWJkYVN1YnNjcmlwdGlvbihvdXRib3VuZE1lc3NhZ2VGdW5jdGlvbiwge1xyXG4gICAgICAgICAgICBmaWx0ZXJQb2xpY3k6IHtcclxuICAgICAgICAgICAgICBNZXNzYWdlVmlzaWJpbGl0eTogc25zLlN1YnNjcmlwdGlvbkZpbHRlci5zdHJpbmdGaWx0ZXIoe1xyXG4gICAgICAgICAgICAgICAgICAgIGFsbG93bGlzdDogWydDVVNUT01FUicsICdBTEwnXSxcclxuICAgICAgICAgICAgICAgIH0pLFxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICB9KVxyXG4gICAgICAgICk7XHJcbiAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICBpZihzbXNPdXRib3VuZE1zZ1N0cmVhbWluZ1RvcGljKXtcclxuICAgICAgc21zT3V0Ym91bmRNc2dTdHJlYW1pbmdUb3BpYy5hZGRTdWJzY3JpcHRpb24oXHJcbiAgICAgICAgbmV3IHN1YnNjcmlwdGlvbnMuTGFtYmRhU3Vic2NyaXB0aW9uKG91dGJvdW5kTWVzc2FnZUZ1bmN0aW9uLCB7XHJcbiAgICAgICAgICBmaWx0ZXJQb2xpY3k6IHtcclxuICAgICAgICAgICAgTWVzc2FnZVZpc2liaWxpdHk6IHNucy5TdWJzY3JpcHRpb25GaWx0ZXIuc3RyaW5nRmlsdGVyKHtcclxuICAgICAgICAgICAgICAgICAgYWxsb3dsaXN0OiBbJ0NVU1RPTUVSJywgJ0FMTCddLFxyXG4gICAgICAgICAgICAgIH0pLFxyXG4gICAgICAgICAgfVxyXG4gICAgICAgIH0pXHJcbiAgICAgICk7IFxyXG4gICAgfVxyXG5cclxuICB9XHJcbn1cclxuXHJcbi8vIHBpbnBvaW50IHByb2plY3QgaW4gY2RrIC0gcGhvbmUgbnVtYmVyIGhhcyB0byBiZSBtYW51YWxseSBjbGFpbWVkXHJcbi8vIGluYm91bmQgU05TIHRvcGljIChmb3IgU01TKVxyXG4vLyBpbmJvdW5kIEFQSSBHYXRld2F5IChkaWdpdGFsIGNoYW5uZWwpXHJcbi8vIGluYm91bmQgTGFtYmRhXHJcbi8vIEREQiAtXHJcbi8vIG91dGJvdW5kIFNOUyB0b3BpY1xyXG4vLyBvdXRib3VuZCBsYW1iZGFcclxuIl19
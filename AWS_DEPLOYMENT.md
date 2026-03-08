# AWS Deployment Guide: ECS Fargate Scheduled Task

Deploy the TripIt → Reclaim timezone sync as a scheduled ECS Fargate task that runs daily at 3 AM UTC. The container runs, syncs, and exits — you only pay for the few seconds of execution (~$0.01/month).

## Prerequisites

- AWS CLI installed and configured (`aws configure`)
- Docker installed
- Your TripIt iCal feed URL and Reclaim.ai API token

## Architecture

```
EventBridge Rule (cron: daily 3 AM UTC)
  → ECS RunTask on Fargate (256 CPU / 512 MiB)
      → Pulls image from ECR
      → Injects secrets from SSM Parameter Store
      → Runs: node sync.mjs sync
      → Logs to CloudWatch
      → (Optional) Sends email notification via SNS
      → Container exits (no ongoing cost)
```

## Step-by-step deployment

Set these variables for use throughout the guide:

```bash
export AWS_REGION=us-west-1          # change to your preferred region
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
```

### 1. Create ECR repository

```bash
aws ecr create-repository \
  --repository-name reclaim-tripit-sync \
  --region $AWS_REGION \
  --image-scanning-configuration scanOnPush=true
```

### 2. Build and push Docker image

```bash
# Authenticate Docker to ECR
aws ecr get-login-password --region $AWS_REGION | \
  docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com

# Build the image
docker build -t reclaim-tripit-sync .

# Tag and push
docker tag reclaim-tripit-sync:latest \
  $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/reclaim-tripit-sync:latest

docker push $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/reclaim-tripit-sync:latest
```

> **Tip:** If your internet upload is slow, launch a temporary EC2 instance in the same region, clone the repo there, build and push from within AWS where the network to ECR is fast and free. Terminate the instance when done.

### 3. Store secrets in SSM Parameter Store

```bash
aws ssm put-parameter \
  --name /reclaim-tripit-sync/TRIPIT_ICAL_URL \
  --type SecureString \
  --value 'YOUR_TRIPIT_ICAL_URL' \
  --region $AWS_REGION

aws ssm put-parameter \
  --name /reclaim-tripit-sync/RECLAIM_API_TOKEN \
  --type SecureString \
  --value 'YOUR_RECLAIM_API_TOKEN' \
  --region $AWS_REGION
```

### 4. Create CloudWatch log group

```bash
aws logs create-log-group \
  --log-group-name /ecs/reclaim-tripit-sync \
  --region $AWS_REGION

aws logs put-retention-policy \
  --log-group-name /ecs/reclaim-tripit-sync \
  --retention-in-days 30 \
  --region $AWS_REGION
```

### 5. Create IAM roles

**Task execution role** (used by ECS to pull images, fetch secrets, write logs):

```bash
aws iam create-role \
  --role-name reclaim-tripit-sync-execution-role \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "ecs-tasks.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'

aws iam attach-role-policy \
  --role-name reclaim-tripit-sync-execution-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy

aws iam put-role-policy \
  --role-name reclaim-tripit-sync-execution-role \
  --policy-name SSMParameterAccess \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": ["ssm:GetParameters", "ssm:GetParameter"],
      "Resource": ["arn:aws:ssm:'$AWS_REGION':'$AWS_ACCOUNT_ID':parameter/reclaim-tripit-sync/*"]
    }]
  }'
```

**Task role** (used by the container at runtime — needs SNS publish if notifications are enabled):

```bash
aws iam create-role \
  --role-name reclaim-tripit-sync-task-role \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "ecs-tasks.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'

# Optional: Allow SNS publish for email notifications (skip if not using notifications)
aws iam put-role-policy \
  --role-name reclaim-tripit-sync-task-role \
  --policy-name SNSPublishAccess \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": "sns:Publish",
      "Resource": "arn:aws:sns:'$AWS_REGION':'$AWS_ACCOUNT_ID':reclaim-tripit-sync"
    }]
  }'
```

**EventBridge role** (allows EventBridge to trigger ECS tasks):

```bash
aws iam create-role \
  --role-name reclaim-tripit-sync-eventbridge-role \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "events.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'

aws iam put-role-policy \
  --role-name reclaim-tripit-sync-eventbridge-role \
  --policy-name ECSRunTask \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": "ecs:RunTask",
      "Resource": "arn:aws:ecs:'$AWS_REGION':'$AWS_ACCOUNT_ID':task-definition/reclaim-tripit-sync:*",
      "Condition": {
        "ArnEquals": {
          "ecs:cluster": "arn:aws:ecs:'$AWS_REGION':'$AWS_ACCOUNT_ID':cluster/reclaim-tripit-sync"
        }
      }
    },
    {
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": [
        "arn:aws:iam::'$AWS_ACCOUNT_ID':role/reclaim-tripit-sync-execution-role",
        "arn:aws:iam::'$AWS_ACCOUNT_ID':role/reclaim-tripit-sync-task-role"
      ]
    }]
  }'
```

### 6. Create ECS cluster

```bash
aws ecs create-cluster \
  --cluster-name reclaim-tripit-sync \
  --region $AWS_REGION
```

### 7. (Optional) Set up SNS email notifications

If you want email notifications when the sync makes changes to Reclaim timezone overrides:

```bash
# Create SNS topic
aws sns create-topic \
  --name reclaim-tripit-sync \
  --region $AWS_REGION

# Subscribe your email (you'll receive a confirmation email — click the link to confirm)
aws sns subscribe \
  --topic-arn arn:aws:sns:$AWS_REGION:$AWS_ACCOUNT_ID:reclaim-tripit-sync \
  --protocol email \
  --notification-endpoint your-email@example.com \
  --region $AWS_REGION
```

> **Important:** Check your inbox and confirm the subscription before testing notifications.

### 8. Register task definition

The `command` override bypasses the Dockerfile's built-in cron entrypoint, running a single sync and exiting:

```bash
aws ecs register-task-definition \
  --region $AWS_REGION \
  --family reclaim-tripit-sync \
  --requires-compatibilities FARGATE \
  --network-mode awsvpc \
  --cpu 256 \
  --memory 512 \
  --execution-role-arn arn:aws:iam::$AWS_ACCOUNT_ID:role/reclaim-tripit-sync-execution-role \
  --task-role-arn arn:aws:iam::$AWS_ACCOUNT_ID:role/reclaim-tripit-sync-task-role \
  --container-definitions '[
    {
      "name": "reclaim-tripit-sync",
      "image": "'$AWS_ACCOUNT_ID'.dkr.ecr.'$AWS_REGION'.amazonaws.com/reclaim-tripit-sync:latest",
      "command": ["node", "sync.mjs", "sync"],
      "essential": true,
      "environment": [
        {
          "name": "SNS_TOPIC_ARN",
          "value": "arn:aws:sns:'$AWS_REGION':'$AWS_ACCOUNT_ID':reclaim-tripit-sync"
        }
      ],
      "secrets": [
        {
          "name": "TRIPIT_ICAL_URL",
          "valueFrom": "arn:aws:ssm:'$AWS_REGION':'$AWS_ACCOUNT_ID':parameter/reclaim-tripit-sync/TRIPIT_ICAL_URL"
        },
        {
          "name": "RECLAIM_API_TOKEN",
          "valueFrom": "arn:aws:ssm:'$AWS_REGION':'$AWS_ACCOUNT_ID':parameter/reclaim-tripit-sync/RECLAIM_API_TOKEN"
        }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/reclaim-tripit-sync",
          "awslogs-region": "'$AWS_REGION'",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]'
```

> **Note:** Remove the `environment` block for `SNS_TOPIC_ARN` if you don't want notifications. The sync will work fine without it.
>
> **Running outside AWS:** If running the container outside AWS (e.g., local Docker), set `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_REGION` environment variables for SNS to work.

### 9. Set up networking

Identify your default VPC, a subnet, and the default security group:

```bash
VPC_ID=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text --region $AWS_REGION)

SUBNET_ID=$(aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC_ID \
  --query 'Subnets[0].SubnetId' --output text --region $AWS_REGION)

SG_ID=$(aws ec2 describe-security-groups --filters Name=vpc-id,Values=$VPC_ID Name=group-name,Values=default \
  --query 'SecurityGroups[0].GroupId' --output text --region $AWS_REGION)

echo "VPC=$VPC_ID SUBNET=$SUBNET_ID SG=$SG_ID"
```

### 10. Create EventBridge scheduled rule

```bash
aws events put-rule \
  --name reclaim-tripit-sync-daily \
  --schedule-expression 'cron(0 3 * * ? *)' \
  --state ENABLED \
  --region $AWS_REGION

aws events put-targets \
  --rule reclaim-tripit-sync-daily \
  --region $AWS_REGION \
  --targets '[{
    "Id": "reclaim-tripit-sync-target",
    "Arn": "arn:aws:ecs:'$AWS_REGION':'$AWS_ACCOUNT_ID':cluster/reclaim-tripit-sync",
    "RoleArn": "arn:aws:iam::'$AWS_ACCOUNT_ID':role/reclaim-tripit-sync-eventbridge-role",
    "EcsParameters": {
      "TaskDefinitionArn": "arn:aws:ecs:'$AWS_REGION':'$AWS_ACCOUNT_ID':task-definition/reclaim-tripit-sync",
      "TaskCount": 1,
      "LaunchType": "FARGATE",
      "PlatformVersion": "LATEST",
      "NetworkConfiguration": {
        "awsvpcConfiguration": {
          "Subnets": ["'$SUBNET_ID'"],
          "SecurityGroups": ["'$SG_ID'"],
          "AssignPublicIp": "ENABLED"
        }
      }
    }
  }]'
```

### 11. Test it

Run a one-off task to verify everything works:

```bash
aws ecs run-task \
  --cluster reclaim-tripit-sync \
  --task-definition reclaim-tripit-sync \
  --launch-type FARGATE \
  --network-configuration '{
    "awsvpcConfiguration": {
      "subnets": ["'$SUBNET_ID'"],
      "securityGroups": ["'$SG_ID'"],
      "assignPublicIp": "ENABLED"
    }
  }' \
  --region $AWS_REGION
```

Check the logs:

```bash
aws logs tail /ecs/reclaim-tripit-sync --follow --region $AWS_REGION
```

You should see output like:

```
=== TripIt → Reclaim Travel Timezone Sync ===
Mode: sync
Fetching TripIt iCal feed...
  Found 77 VEVENT(s)
  Identified 4 trip-level event(s)
  Found 15 flight arrival(s)
Building timezone segments...
  Built 22 segment(s)
  4 future segment(s) > 1 day
  2 after deduplication
...
Sync complete!
```

## Cost estimate

- **Fargate:** ~$0.01/month (256 CPU / 512 MiB running for ~30 seconds daily)
- **SSM Parameter Store:** Free (standard parameters)
- **CloudWatch Logs:** Negligible with 30-day retention
- **ECR:** Free tier covers 500 MB/month
- **SNS:** Free tier covers 1,000 email notifications/month

## IAM permissions

Your AWS user/role needs the following permissions to deploy:
- `ecr:*` — create repository, push images
- `ecs:*` — create cluster, register task definitions, run tasks
- `iam:*` — create roles and policies
- `ssm:PutParameter` — store secrets
- `logs:*` — create log groups
- `events:*` — create scheduled rules
- `ec2:Describe*` — look up VPC/subnet/security group info

Or attach `AdministratorAccess` temporarily for the initial setup.

## Cleanup

To remove all AWS resources:

```bash
# Delete EventBridge rule and target
aws events remove-targets --rule reclaim-tripit-sync-daily --ids reclaim-tripit-sync-target --region $AWS_REGION
aws events delete-rule --name reclaim-tripit-sync-daily --region $AWS_REGION

# Deregister task definition
aws ecs deregister-task-definition --task-definition reclaim-tripit-sync:1 --region $AWS_REGION

# Delete ECS cluster
aws ecs delete-cluster --cluster reclaim-tripit-sync --region $AWS_REGION

# Delete ECR repository
aws ecr delete-repository --repository-name reclaim-tripit-sync --force --region $AWS_REGION

# Delete SSM parameters
aws ssm delete-parameter --name /reclaim-tripit-sync/TRIPIT_ICAL_URL --region $AWS_REGION
aws ssm delete-parameter --name /reclaim-tripit-sync/RECLAIM_API_TOKEN --region $AWS_REGION

# Delete CloudWatch log group
aws logs delete-log-group --log-group-name /ecs/reclaim-tripit-sync --region $AWS_REGION

# Delete SNS topic and subscriptions (if configured)
TOPIC_ARN=arn:aws:sns:$AWS_REGION:$AWS_ACCOUNT_ID:reclaim-tripit-sync
aws sns list-subscriptions-by-topic --topic-arn $TOPIC_ARN --region $AWS_REGION \
  --query 'Subscriptions[].SubscriptionArn' --output text | \
  xargs -n1 aws sns unsubscribe --subscription-arn
aws sns delete-topic --topic-arn $TOPIC_ARN --region $AWS_REGION

# Delete IAM roles and policies
aws iam detach-role-policy --role-name reclaim-tripit-sync-execution-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
aws iam delete-role-policy --role-name reclaim-tripit-sync-execution-role --policy-name SSMParameterAccess
aws iam delete-role --role-name reclaim-tripit-sync-execution-role
aws iam delete-role-policy --role-name reclaim-tripit-sync-task-role --policy-name SNSPublishAccess 2>/dev/null || true
aws iam delete-role --role-name reclaim-tripit-sync-task-role
aws iam delete-role-policy --role-name reclaim-tripit-sync-eventbridge-role --policy-name ECSRunTask
aws iam delete-role --role-name reclaim-tripit-sync-eventbridge-role
```

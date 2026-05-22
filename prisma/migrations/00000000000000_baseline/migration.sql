-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('SUPER_ADMIN', 'CLUB_ADMIN', 'HEAD_COACH', 'ASSISTANT_COACH', 'ANALYST', 'MEDICAL_STAFF', 'SCOUT', 'MANAGER', 'COACH', 'PARENT', 'PLAYER');

-- CreateEnum
CREATE TYPE "SubscriptionPlan" AS ENUM ('BASIC', 'PRO', 'ACADEMY', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'PAST_DUE', 'CANCELED', 'TRIALING', 'INCOMPLETE');

-- CreateEnum
CREATE TYPE "PlayerPosition" AS ENUM ('GK', 'DC', 'DL', 'DR', 'DMC', 'ML', 'MR', 'MC', 'AMC', 'AML', 'AMR', 'ST');

-- CreateEnum
CREATE TYPE "Foot" AS ENUM ('RIGHT', 'LEFT', 'BOTH');

-- CreateEnum
CREATE TYPE "MatchResult" AS ENUM ('WIN', 'DRAW', 'LOSS');

-- CreateEnum
CREATE TYPE "CompetitionType" AS ENUM ('LEAGUE', 'CUP', 'FRIENDLY', 'ELITE', 'ASSOCIATION');

-- CreateEnum
CREATE TYPE "InjurySeverity" AS ENUM ('MINOR', 'MODERATE', 'SERIOUS', 'CRITICAL');

-- CreateEnum
CREATE TYPE "DrillType" AS ENUM ('TECHNICAL_PASSING', 'SPRINT_INTERVALS', 'SHOOTING_PRACTICE', 'DEFENSIVE_SHAPE', 'TRANSITION_PLAY', 'RECOVERY', 'SET_PIECES', 'POSSESSION', 'PRESSING', 'CUSTOM');

-- CreateEnum
CREATE TYPE "ScoutRecommendation" AS ENUM ('SIGN', 'MONITOR', 'SKIP');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('INCOME', 'EXPENSE');

-- CreateEnum
CREATE TYPE "MedicalStatus" AS ENUM ('HEALTHY', 'INJURED', 'RECOVERING', 'SUSPENDED', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PAID', 'PARTIAL', 'UNPAID', 'OVERDUE', 'EXEMPT');

-- CreateEnum
CREATE TYPE "PlayerAuditAction" AS ENUM ('CREATE', 'UPDATE', 'DEACTIVATE', 'REACTIVATE', 'MEDICAL_STATUS_CHANGED', 'PAYMENT_STATUS_CHANGED', 'DELETE');

-- CreateEnum
CREATE TYPE "TeamKind" AS ENUM ('SENIOR', 'RESERVES', 'ACADEMY_U23', 'ACADEMY_U21', 'ACADEMY_U19', 'ACADEMY_U17', 'ACADEMY_U15', 'ACADEMY_U13', 'ACADEMY_U11', 'ACADEMY_U9', 'ACADEMY_U7', 'WOMEN', 'WOMEN_U19', 'WOMEN_U17', 'FUTSAL', 'OTHER');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MEN', 'WOMEN', 'MIXED');

-- CreateEnum
CREATE TYPE "MembershipRole" AS ENUM ('CLUB_OWNER', 'CLUB_ADMIN', 'HEAD_COACH', 'ASSISTANT_COACH', 'ANALYST', 'MEDICAL_STAFF', 'PHYSIO', 'SCOUT', 'FINANCE_MANAGER', 'PARENT', 'PLAYER', 'DEVICE');

-- CreateEnum
CREATE TYPE "MembershipAuditAction" AS ENUM ('GRANT', 'REVOKE', 'ROLE_CHANGED', 'TEAM_CHANGED', 'REACTIVATE', 'CONTEXT_SWITCH');

-- CreateEnum
CREATE TYPE "MatchStatus" AS ENUM ('SCHEDULED', 'LIVE', 'HALFTIME', 'FT', 'POSTPONED', 'ABANDONED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MatchSide" AS ENUM ('HOME', 'AWAY');

-- CreateEnum
CREATE TYPE "MatchTimelineKind" AS ENUM ('GOAL', 'OWN_GOAL', 'ASSIST', 'SHOT', 'SHOT_ON_TARGET', 'SHOT_OFF_TARGET', 'SAVE', 'YELLOW_CARD', 'SECOND_YELLOW', 'RED_CARD', 'SUBSTITUTION', 'INJURY', 'FOUL', 'CORNER', 'OFFSIDE', 'PENALTY_AWARDED', 'PENALTY_SCORED', 'PENALTY_MISSED', 'POSSESSION_TICK', 'TACTICAL_NOTE', 'AI_INSIGHT', 'CUSTOM');

-- CreateEnum
CREATE TYPE "MatchTacticalPhase" AS ENUM ('OPEN_PLAY', 'ATTACKING_TRANSITION', 'DEFENSIVE_TRANSITION', 'ATTACKING_ORGANIZATION', 'DEFENSIVE_ORGANIZATION', 'SET_PIECE_FOR', 'SET_PIECE_AGAINST');

-- CreateEnum
CREATE TYPE "TacticalSource" AS ENUM ('MANUAL', 'AUTO_INTERVAL', 'AI_AGENT', 'VISION');

-- CreateEnum
CREATE TYPE "MatchAuditAction" AS ENUM ('CREATE', 'UPDATE', 'STATUS_CHANGED', 'LINEUP_SET', 'TIMELINE_ADDED', 'TIMELINE_EDITED', 'TIMELINE_DELETED', 'SNAPSHOT_TAKEN', 'DELETE');

-- CreateEnum
CREATE TYPE "SensorPacketKind" AS ENUM ('GPS', 'IMU', 'ECG', 'HEART_RATE', 'HEALTH_BUNDLE', 'EVENT', 'VISION_FRAME', 'TURF_NODE', 'POWER', 'DIAGNOSTIC');

-- CreateEnum
CREATE TYPE "AutomationKind" AS ENUM ('SCHEDULE_REPORT', 'INJURY_RISK_SCAN', 'TRAINING_PLAN', 'MATCH_PREVIEW', 'MATCH_RECAP', 'FATIGUE_SCAN', 'FINANCE_SUMMARY', 'COMMS_BROADCAST', 'DEVICE_HEALTHCHECK', 'DATA_PIPELINE', 'CUSTOM');

-- CreateEnum
CREATE TYPE "AutomationStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCESS', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AIAgent" AS ENUM ('CLUB_MANAGER', 'TACTICAL', 'MEDICAL', 'SCOUTING', 'FINANCE', 'TRAINING', 'MATCH_OPS', 'COMMS', 'DEVICE_MGMT', 'BIG_DATA');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'WARN', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('OPEN', 'ACK', 'RESOLVED', 'MUTED');

-- CreateEnum
CREATE TYPE "DeviceProvisionStatus" AS ENUM ('REGISTERED', 'PROVISIONED', 'ACTIVE', 'RETIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "SportKind" AS ENUM ('FOOTBALL', 'BASKETBALL', 'TENNIS', 'HANDBALL', 'ATHLETICS', 'FUTSAL', 'VOLLEYBALL', 'CUSTOM');

-- CreateEnum
CREATE TYPE "CameraStatus" AS ENUM ('REGISTERED', 'CALIBRATED', 'ACTIVE', 'OFFLINE', 'RETIRED');

-- CreateEnum
CREATE TYPE "CameraKind" AS ENUM ('RGB', 'DEPTH', 'EVENT', 'PANORAMIC', 'AERIAL');

-- CreateEnum
CREATE TYPE "PredictionKind" AS ENUM ('TACTICAL_COLLAPSE', 'INJURY_RISK', 'FATIGUE_TRAJECTORY', 'POSITIONING_DEGRADATION', 'MOMENTUM_SHIFT', 'SUBSTITUTION_WINDOW');

-- CreateEnum
CREATE TYPE "SecurityEventKind" AS ENUM ('LOGIN_SUCCESS', 'LOGIN_FAILED', 'LOGIN_LOCKED', 'TENANT_MISMATCH', 'RATE_LIMITED', 'SUSPICIOUS_PAYLOAD', 'DEVICE_REJECTED', 'DEVICE_REPLAY', 'DEVICE_TS_SKEW', 'PROMPT_INJECTION_SUSPECT', 'UNAUTHORIZED_AI_ATTEMPT', 'AUDIT_CHAIN_VERIFIED', 'AUDIT_CHAIN_BROKEN', 'APPROVAL_REQUESTED', 'APPROVAL_GRANTED', 'APPROVAL_REJECTED', 'APPROVAL_EXPIRED', 'CUSTOM');

-- CreateEnum
CREATE TYPE "SecuritySeverity" AS ENUM ('INFO', 'WARN', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AIApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'EXECUTED');

-- CreateEnum
CREATE TYPE "AIApprovalKind" AS ENUM ('DELETE_DATA', 'CHANGE_TACTICS_LIVE', 'MASS_MESSAGE', 'APPROVE_TRANSFER', 'MEDICAL_RECOMMENDATION', 'PAYMENT_ACTION', 'OTHER');

-- CreateEnum
CREATE TYPE "RegionStatus" AS ENUM ('ACTIVE', 'STANDBY', 'DEGRADED', 'OFFLINE');

-- CreateEnum
CREATE TYPE "RegionNodeKind" AS ENUM ('API', 'REALTIME', 'WORKER', 'EDGE_GATEWAY');

-- CreateEnum
CREATE TYPE "AIDecisionImpact" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "EdgeNodeKind" AS ENUM ('CAMERA', 'WEARABLE', 'TURF', 'SMART_BALL', 'BIOCHEM', 'EDGE_BOX');

-- CreateEnum
CREATE TYPE "CompressionStrategy" AS ENUM ('NONE', 'ZSTD', 'LZ4', 'DELTA');

-- CreateEnum
CREATE TYPE "ProvisioningStatus" AS ENUM ('CREATED', 'IN_PROGRESS', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "BillingPlanKind" AS ENUM ('CLUB', 'FEDERATION', 'ACADEMY', 'DEVICE_HW', 'DEVICE_AI', 'ANALYTICS', 'CUSTOM');

-- CreateEnum
CREATE TYPE "BillingAccountStatus" AS ENUM ('TRIAL', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'PAUSED');

-- CreateEnum
CREATE TYPE "MetricKind" AS ENUM ('COUNTER', 'GAUGE', 'HISTOGRAM');

-- CreateEnum
CREATE TYPE "VisionStreamStatus" AS ENUM ('ACTIVE', 'PAUSED', 'CLOSED');

-- CreateEnum
CREATE TYPE "CameraRigSyncStrategy" AS ENUM ('NTP', 'PTP', 'EVENT_BEACON', 'MANUAL');

-- CreateEnum
CREATE TYPE "CameraRigRole" AS ENUM ('CORNER', 'FENCE', 'OVERHEAD', 'WEARABLE', 'PANORAMIC', 'AERIAL', 'GENERIC');

-- CreateEnum
CREATE TYPE "TacticalSignalKind" AS ENUM ('FORMATION', 'PRESSING', 'DEFENSIVE_LINE', 'OVERLOAD_ZONE', 'SPACE_CREATION', 'TRANSITION_MOMENT', 'COUNTERATTACK', 'POSITIONAL_COLLAPSE');

-- CreateEnum
CREATE TYPE "VisionSubjectKind" AS ENUM ('PLAYER', 'BALL', 'OBJECT', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "EdgeVisionRuntimeStatus" AS ENUM ('PROVISIONED', 'ACTIVE', 'DEGRADED', 'OFFLINE', 'RETIRED');

-- CreateEnum
CREATE TYPE "HardwareProvisioningStatus" AS ENUM ('CREATED', 'IN_PROGRESS', 'ACTIVATED', 'SEALED', 'FAILED');

-- CreateEnum
CREATE TYPE "FederatedJobStatus" AS ENUM ('PENDING', 'RUNNING', 'AGGREGATING', 'COMPLETED', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "AttestationStatus" AS ENUM ('PENDING', 'VERIFIED', 'FAILED', 'REVOKED');

-- CreateEnum
CREATE TYPE "SimulationStatus" AS ENUM ('DRAFT', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "CoachRecommendationKind" AS ENUM ('TACTICAL', 'INJURY_RISK', 'SUBSTITUTION', 'TACTICAL_ADAPTATION', 'MATCH_ADJUSTMENT', 'FORMATION_OPTIMIZATION', 'CUSTOM');

-- CreateEnum
CREATE TYPE "GraphSnapshotKind" AS ENUM ('PRESSURE', 'PASSING', 'THREAT', 'INFLUENCE', 'CUSTOM');

-- CreateEnum
CREATE TYPE "ExecAgentRole" AS ENUM ('SPORTING_DIRECTOR', 'RECRUITMENT', 'MEDICAL_EXEC', 'FINANCE_EXEC', 'MARKETING', 'ACADEMY_HEAD', 'PERFORMANCE');

-- CreateEnum
CREATE TYPE "CouncilStatus" AS ENUM ('OPEN', 'VOTING', 'CLOSED');

-- CreateEnum
CREATE TYPE "CouncilVoteType" AS ENUM ('APPROVE', 'REJECT', 'ABSTAIN');

-- CreateEnum
CREATE TYPE "RecruitmentStatus" AS ENUM ('LEAD', 'SCOUTED', 'EVALUATED', 'TARGETED', 'OFFERED', 'SIGNED', 'REJECTED', 'LOST');

-- CreateEnum
CREATE TYPE "TrainingPlanStatus" AS ENUM ('DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELED');

-- CreateEnum
CREATE TYPE "MarketplaceItemKind" AS ENUM ('TRANSFER_LISTING', 'DEVICE_LISTING', 'SERVICE_LISTING', 'ACADEMY_PROGRAM', 'GENERIC');

-- CreateEnum
CREATE TYPE "MarketplaceItemStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'CLOSED');

-- CreateEnum
CREATE TYPE "KnowledgeNodeKind" AS ENUM ('TACTICAL', 'MEDICAL', 'ECONOMIC', 'SCOUTING', 'GENERAL');

-- CreateEnum
CREATE TYPE "KnowledgeNodeType" AS ENUM ('PLAYER', 'CLUB', 'COACH', 'SCOUT', 'AGENT', 'TOURNAMENT', 'STADIUM', 'COMPETITION', 'COUNTRY', 'ACADEMY');

-- CreateEnum
CREATE TYPE "KnowledgeEdgeType" AS ENUM ('PLAYS_FOR', 'COACHES', 'REPRESENTS', 'HOSTS', 'IN_COMPETITION', 'BELONGS_TO', 'DEVELOPS', 'NATIVE_OF', 'SCOUTED_BY', 'SIGNED_WITH', 'CUSTOM');

-- CreateEnum
CREATE TYPE "DiscoveryStatus" AS ENUM ('PROSPECT', 'EVALUATING', 'CONFIRMED', 'RECOMMENDED', 'REJECTED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ReasoningKind" AS ENUM ('RECRUITMENT', 'TACTICAL', 'MEDICAL', 'ECONOMIC', 'DEVELOPMENT', 'CUSTOM');

-- CreateEnum
CREATE TYPE "AuthSessionStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "MfaMethod" AS ENUM ('NONE', 'TOTP', 'EMAIL', 'BACKUP_CODE');

-- CreateEnum
CREATE TYPE "AttendanceMark" AS ENUM ('PRESENT', 'ABSENT', 'LATE', 'EXCUSED');

-- CreateEnum
CREATE TYPE "OperationsPaymentState" AS ENUM ('PENDING', 'PAID', 'OVERDUE', 'REFUNDED', 'CANCELED');

-- CreateEnum
CREATE TYPE "ClubEventKind" AS ENUM ('TRAINING', 'MATCH', 'MEDICAL', 'MEETING', 'TRAVEL', 'OTHER');

-- CreateEnum
CREATE TYPE "PlayerContractState" AS ENUM ('DRAFT', 'ACTIVE', 'EXPIRED', 'TERMINATED', 'RENEWED');

-- CreateEnum
CREATE TYPE "GdprRequestKind" AS ENUM ('EXPORT', 'DELETE', 'RECTIFICATION', 'PORTABILITY');

-- CreateEnum
CREATE TYPE "GdprRequestState" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ConsentScope" AS ENUM ('MEDICAL', 'MARKETING', 'DATA_SHARING', 'RESEARCH', 'IMAGE_USE', 'CUSTOM');

-- CreateEnum
CREATE TYPE "HealthCheckState" AS ENUM ('OK', 'DEGRADED', 'DOWN');

-- CreateEnum
CREATE TYPE "AlertRuleState" AS ENUM ('ACTIVE', 'MUTED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "BackupKind" AS ENUM ('SCHEDULED', 'MANUAL', 'PRE_DEPLOY', 'RESTORE_POINT');

-- CreateEnum
CREATE TYPE "DeviceInventoryState" AS ENUM ('STOCK', 'DEPLOYED', 'RMA', 'RETIRED');

-- CreateEnum
CREATE TYPE "UserNotificationKind" AS ENUM ('SYSTEM', 'ATTENDANCE_REMINDER', 'PAYMENT_REMINDER', 'TRAINING_UPDATE', 'INJURY_ALERT', 'DEVICE_ALERT', 'GDPR_UPDATE');

-- CreateEnum
CREATE TYPE "WhiteLabelDomainStatus" AS ENUM ('PENDING', 'VERIFYING', 'ACTIVE', 'FAILED', 'DISABLED');

-- CreateEnum
CREATE TYPE "WhiteLabelAuditAction" AS ENUM ('CONFIG_CREATED', 'CONFIG_UPDATED', 'CONFIG_RESET', 'DOMAIN_ADDED', 'DOMAIN_REMOVED', 'DOMAIN_VERIFIED', 'DOMAIN_FAILED', 'DOMAIN_PROMOTED', 'ASSET_REPLACED');

-- CreateEnum
CREATE TYPE "PlanSource" AS ENUM ('STRIPE', 'OVERRIDE');

-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('PLATFORM_OWNER', 'PLATFORM_ADMIN', 'PLATFORM_SUPPORT', 'PLATFORM_BILLING', 'PLATFORM_READ_ONLY');

-- CreateEnum
CREATE TYPE "AssetType" AS ENUM ('LOGO_LIGHT', 'LOGO_DARK', 'FAVICON', 'OG_IMAGE', 'PDF_HEADER', 'PDF_FOOTER', 'EMAIL_HEADER_BG');

-- CreateEnum
CREATE TYPE "AssetStorage" AS ENUM ('LOCAL', 'S3', 'EXTERNAL_URL');

-- CreateEnum
CREATE TYPE "PlatformAuditCategory" AS ENUM ('BRANDING', 'DOMAIN', 'ASSET', 'PALETTE', 'BILLING', 'LICENSE', 'LIMITS', 'ACCESS', 'IMPERSONATION', 'FEATURE_FLAG', 'PLATFORM_ADMIN', 'OTHER');

-- CreateEnum
CREATE TYPE "PlatformAuditResult" AS ENUM ('SUCCESS', 'FAILURE', 'REJECTED');

-- CreateEnum
CREATE TYPE "ImpersonationStatus" AS ENUM ('ACTIVE', 'ENDED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "TerritoryType" AS ENUM ('COUNTRY', 'STATE', 'REGION', 'CITY', 'DISTRICT');

-- CreateEnum
CREATE TYPE "FranchiseLevel" AS ENUM ('MASTER', 'REGIONAL', 'LOCAL', 'ACADEMY');

-- CreateEnum
CREATE TYPE "FranchiseStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'IN_RENEWAL', 'TERMINATED');

-- CreateEnum
CREATE TYPE "OwnershipModel" AS ENUM ('SINGLE_OWNER', 'MULTI_OWNER', 'INVESTOR_GROUP', 'HOLDING_COMPANY', 'JOINT_VENTURE');

-- CreateEnum
CREATE TYPE "OwnerType" AS ENUM ('INDIVIDUAL', 'ENTITY', 'INVESTOR_GROUP');

-- CreateEnum
CREATE TYPE "TerritoryRightType" AS ENUM ('EXCLUSIVE', 'NON_EXCLUSIVE', 'FIRST_REFUSAL');

-- CreateEnum
CREATE TYPE "ExpansionRequestStatus" AS ENUM ('PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'ESCALATED', 'COMPLETED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "AcquisitionStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'COMPLETED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('PENDING', 'APPROVED', 'EXECUTED', 'CANCELLED', 'REJECTED');

-- CreateEnum
CREATE TYPE "TransferReason" AS ENUM ('VOLUNTARY', 'ACQUISITION', 'INHERITANCE', 'COURT_ORDER', 'DEFAULT', 'CORPORATE_RESTRUCTURE');

-- CreateEnum
CREATE TYPE "RevenueCategory" AS ENUM ('SUBSCRIPTION', 'TRANSFER', 'SPONSORSHIP', 'MERCHANDISE', 'ACADEMY_FEE', 'MATCH_REVENUE', 'BROADCAST', 'OTHER', 'ALL');

-- CreateEnum
CREATE TYPE "RevenueTrigger" AS ENUM ('PAYMENT_RECEIVED', 'INVOICE_ISSUED', 'MANUAL');

-- CreateEnum
CREATE TYPE "RevenueRecipientType" AS ENUM ('HEADQUARTERS', 'MASTER', 'REGIONAL', 'LOCAL', 'ACADEMY', 'INVESTOR', 'SPONSOR', 'OTHER');

-- CreateEnum
CREATE TYPE "DistributionStatus" AS ENUM ('COMPUTED', 'EXECUTING', 'EXECUTED', 'FAILED', 'REVERSED');

-- CreateEnum
CREATE TYPE "AllocationStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ContractType" AS ENUM ('FRANCHISE_AGREEMENT', 'AREA_DEVELOPMENT', 'OPERATING_AGREEMENT', 'SUB_FRANCHISE', 'AMENDMENT');

-- CreateEnum
CREATE TYPE "ContractStatus" AS ENUM ('DRAFT', 'PENDING_SIGNATURE', 'ACTIVE', 'RENEWED', 'EXPIRED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "RenewalStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'EXECUTED');

-- CreateEnum
CREATE TYPE "TerminationReason" AS ENUM ('VOLUNTARY', 'BREACH', 'NON_PAYMENT', 'PERFORMANCE', 'MUTUAL', 'EXPIRATION');

-- CreateEnum
CREATE TYPE "TerminationStatus" AS ENUM ('REQUESTED', 'APPROVED', 'EXECUTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ViolationSeverity" AS ENUM ('MINOR', 'MAJOR', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ViolationStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'ESCALATED', 'WAIVED');

-- CreateEnum
CREATE TYPE "ComplianceCategory" AS ENUM ('FINANCIAL', 'OPERATIONAL', 'LEGAL', 'BRAND', 'TRAINING', 'LICENSING');

-- CreateEnum
CREATE TYPE "ComplianceStatus" AS ENUM ('COMPLIANT', 'AT_RISK', 'NON_COMPLIANT', 'NOT_ASSESSED');

-- CreateEnum
CREATE TYPE "FranchiseAuditCategory" AS ENUM ('HIERARCHY', 'OWNERSHIP', 'TRANSFER', 'ACQUISITION', 'TERRITORY', 'EXPANSION', 'REVENUE', 'CONTRACT', 'COMPLIANCE', 'PERFORMANCE', 'OTHER');

-- CreateEnum
CREATE TYPE "FranchiseAuditResult" AS ENUM ('SUCCESS', 'FAILURE', 'REJECTED');

-- CreateEnum
CREATE TYPE "InvestorType" AS ENUM ('PRIVATE', 'ANGEL', 'STRATEGIC', 'INSTITUTIONAL', 'VENTURE_CAPITAL', 'SOVEREIGN', 'SPORTS_HOLDING');

-- CreateEnum
CREATE TYPE "InvestorEntityType" AS ENUM ('PERSON', 'COMPANY', 'FUND', 'FAMILY_OFFICE', 'SOVEREIGN_FUND', 'HOLDING');

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('PENDING', 'IN_REVIEW', 'VERIFIED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "InvestmentEntityType" AS ENUM ('PLATFORM', 'FRANCHISE_UNIT', 'CLUB', 'ACADEMY');

-- CreateEnum
CREATE TYPE "InvestmentRoundType" AS ENUM ('PRE_SEED', 'SEED', 'SERIES_A', 'SERIES_B', 'SERIES_C', 'SERIES_D', 'GROWTH', 'BRIDGE', 'EXPANSION', 'STRATEGIC', 'ACQUISITION');

-- CreateEnum
CREATE TYPE "InvestmentRoundStatus" AS ENUM ('DRAFT', 'OPEN', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InstrumentType" AS ENUM ('EQUITY', 'SAFE', 'CONVERTIBLE_NOTE', 'REVENUE_SHARE', 'FRANCHISE', 'ACADEMY', 'DIRECT_DEBT');

-- CreateEnum
CREATE TYPE "InvestmentStatus" AS ENUM ('COMMITTED', 'FUNDED', 'CONVERTED', 'EXITED', 'DEFAULTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ShareClassCategory" AS ENUM ('COMMON', 'PREFERRED', 'FOUNDER', 'OPTION_POOL', 'WARRANT');

-- CreateEnum
CREATE TYPE "AntiDilutionType" AS ENUM ('NONE', 'FULL_RATCHET', 'WEIGHTED_AVERAGE_BROAD', 'WEIGHTED_AVERAGE_NARROW');

-- CreateEnum
CREATE TYPE "CapTableAcquisitionType" AS ENUM ('FOUNDING', 'ROUND_PURCHASE', 'CONVERSION', 'TRANSFER_IN', 'EXERCISE', 'GRANT', 'EXIT_PROCEEDS', 'REMAINDER');

-- CreateEnum
CREATE TYPE "ShareTransferStatus" AS ENUM ('PENDING', 'APPROVED', 'EXECUTED', 'CANCELLED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ShareTransferReason" AS ENUM ('SECONDARY_SALE', 'INHERITANCE', 'COURT_ORDER', 'CORPORATE_RESTRUCTURE', 'EXERCISE', 'REPURCHASE');

-- CreateEnum
CREATE TYPE "InvestorRightType" AS ENUM ('BOARD_SEAT', 'OBSERVER_SEAT', 'PRO_RATA', 'ROFR', 'DRAG_ALONG', 'TAG_ALONG', 'INFORMATION', 'VETO', 'LIQUIDATION_PREFERENCE', 'ANTI_DILUTION', 'REDEMPTION', 'MFN');

-- CreateEnum
CREATE TYPE "BoardSeatRole" AS ENUM ('CHAIR', 'DIRECTOR', 'OBSERVER', 'INDEPENDENT');

-- CreateEnum
CREATE TYPE "AgreementType" AS ENUM ('TERM_SHEET', 'SAFE', 'CONVERTIBLE_NOTE', 'STOCK_PURCHASE_AGREEMENT', 'SHAREHOLDER_AGREEMENT', 'INVESTORS_RIGHTS', 'VOTING_AGREEMENT', 'ROFR_AGREEMENT', 'SIDE_LETTER', 'EXIT_AGREEMENT', 'REVENUE_SHARE_AGREEMENT');

-- CreateEnum
CREATE TYPE "AgreementStatus" AS ENUM ('DRAFT', 'PENDING_SIGNATURE', 'EXECUTED', 'TERMINATED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "ExitEventType" AS ENUM ('IPO', 'ACQUISITION', 'MERGER', 'BUYBACK', 'SECONDARY_SALE', 'DIVIDEND', 'DISTRIBUTION', 'LIQUIDATION', 'RECAPITALIZATION');

-- CreateEnum
CREATE TYPE "ExitStatus" AS ENUM ('PROPOSED', 'APPROVED', 'EXECUTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InvestorDistributionType" AS ENUM ('REVENUE_SHARE', 'DIVIDEND', 'INTEREST', 'EXIT_PROCEEDS', 'RETURN_OF_CAPITAL');

-- CreateEnum
CREATE TYPE "InvestorDistributionStatus" AS ENUM ('PENDING', 'COMPUTED', 'PAID', 'FAILED', 'REVERSED');

-- CreateEnum
CREATE TYPE "InvestorAuditCategory" AS ENUM ('PROFILE', 'ENTITY', 'ROUND', 'INVESTMENT', 'CAP_TABLE', 'TRANSFER', 'GOVERNANCE', 'AGREEMENT', 'EXIT', 'DISTRIBUTION', 'OTHER');

-- CreateEnum
CREATE TYPE "InvestorAuditResult" AS ENUM ('SUCCESS', 'FAILURE', 'REJECTED');

-- CreateEnum
CREATE TYPE "AIDomain" AS ENUM ('PLAYER', 'COACH', 'CLUB', 'FRANCHISE', 'INVESTOR', 'EXECUTIVE');

-- CreateEnum
CREATE TYPE "AIDecisionType" AS ENUM ('PLAYER_GROWTH', 'TALENT_DETECTION', 'INJURY_RISK', 'FATIGUE_PREDICTION', 'TRANSFER_RECOMMENDATION', 'TRAINING_OPTIMIZATION', 'LINEUP_RECOMMENDATION', 'TACTICAL_RECOMMENDATION', 'FORMATION_OPTIMIZATION', 'OPPONENT_ANALYSIS', 'MATCH_PREPARATION', 'SUBSTITUTION_RECOMMENDATION', 'TRAINING_PLAN_GENERATION', 'FINANCIAL_HEALTH_PREDICTION', 'BUDGET_OPTIMIZATION', 'SALARY_RISK_ALERT', 'SPONSORSHIP_RECOMMENDATION', 'TRANSFER_MARKET_SUPPORT', 'REGIONAL_EXPANSION_RECOMMENDATION', 'ACADEMY_PROFITABILITY_PREDICTION', 'TERRITORY_RISK_ANALYSIS', 'OPERATOR_PERFORMANCE_SCORING', 'FRANCHISE_INVESTMENT_SCORING', 'INVESTOR_ROI_PREDICTION', 'INVESTMENT_RISK_SCORING', 'VALUATION_ENGINE', 'CAPITAL_ALLOCATION_OPTIMIZATION', 'ACQUISITION_RECOMMENDATION', 'CEO_DASHBOARD_RECOMMENDATION', 'BOARD_STRATEGIC_SUGGESTION', 'EXPANSION_OPPORTUNITY', 'MARKET_ENTRY_PREDICTION', 'ACQUISITION_TARGET');

-- CreateEnum
CREATE TYPE "AIDecisionStatus" AS ENUM ('GENERATED', 'REVIEWED', 'ACCEPTED', 'REJECTED', 'OVERRIDDEN', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AIUrgency" AS ENUM ('INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AIOutcome" AS ENUM ('PENDING', 'POSITIVE', 'NEUTRAL', 'NEGATIVE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "AIModelProvider" AS ENUM ('RULE_BASED', 'CLAUDE', 'HYBRID', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "AIDecisionVisibility" AS ENUM ('CLUB', 'FRANCHISE', 'PLATFORM', 'INVESTOR');

-- CreateEnum
CREATE TYPE "AIFeedbackType" AS ENUM ('ACCEPTANCE', 'OVERRIDE', 'CORRECTION', 'OUTCOME_REPORT', 'RATING');

-- CreateEnum
CREATE TYPE "AIAuditCategory" AS ENUM ('MODEL', 'DECISION', 'REVIEW', 'FEEDBACK', 'INFRA', 'ACCESS');

-- CreateEnum
CREATE TYPE "AIAuditResult" AS ENUM ('SUCCESS', 'FAILURE', 'REJECTED');

-- CreateEnum
CREATE TYPE "VideoSource" AS ENUM ('UPLOAD', 'STREAM_URL', 'HLS', 'RTMP', 'EXTERNAL_PROVIDER');

-- CreateEnum
CREATE TYPE "VideoFormat" AS ENUM ('MP4', 'MKV', 'MOV', 'HLS', 'RTMP', 'WEBM');

-- CreateEnum
CREATE TYPE "IngestStage" AS ENUM ('UPLOADED', 'DEMUXED', 'INFERRED', 'TRACKED', 'EVENTS_DETECTED', 'ANALYTICS_COMPUTED', 'FUSED', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "IngestStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "VisionEventType" AS ENUM ('PASS', 'SHOT', 'SAVE', 'TACKLE', 'INTERCEPTION', 'CLEARANCE', 'DRIBBLE', 'FOUL', 'OFFSIDE', 'YELLOW_CARD', 'RED_CARD', 'GOAL', 'THROW_IN', 'CORNER', 'FREE_KICK', 'PENALTY', 'SUBSTITUTION', 'POSSESSION_CHANGE', 'PRESSING_TRIGGER', 'COUNTER_ATTACK', 'SET_PIECE', 'HEADER', 'CROSS', 'SPRINT', 'ACCELERATION', 'DECELERATION', 'OTHER');

-- CreateEnum
CREATE TYPE "TeamSide" AS ENUM ('HOME', 'AWAY', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "AnalyticsKind" AS ENUM ('HEATMAP', 'PASSING_NETWORK', 'FORMATION_SNAPSHOT', 'PRESSING_EVENT', 'POSSESSION_BLOCK', 'ZONE_OCCUPATION', 'SHAPE_COMPACTNESS', 'DEFENSIVE_LINE', 'TRANSITION_SPEED', 'BUILD_UP_PATTERN', 'SPRINT_PROFILE', 'TECHNICAL_EXECUTION', 'REPETITION_QUALITY', 'OFF_BALL_MOVEMENT');

-- CreateEnum
CREATE TYPE "ClipPurpose" AS ENUM ('HIGHLIGHT', 'COACH_REVIEW', 'PLAYER_FEEDBACK', 'OPPONENT_SCOUTING', 'TALENT_DETECTION', 'TACTICAL_REFERENCE', 'INCIDENT');

-- CreateEnum
CREATE TYPE "ClipStatus" AS ENUM ('REQUESTED', 'RENDERING', 'READY', 'FAILED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LiveStreamStatus" AS ENUM ('IDLE', 'LIVE', 'PAUSED', 'ENDED');

-- CreateEnum
CREATE TYPE "FusionVerdict" AS ENUM ('CONSISTENT', 'MINOR_DRIFT', 'MAJOR_DRIFT', 'CONTRADICTION', 'VISION_ONLY', 'SENSOR_ONLY', 'INSUFFICIENT_DATA');

-- CreateEnum
CREATE TYPE "ScoutingKind" AS ENUM ('OPPONENT_BRIEF', 'TALENT_SCAN', 'RECRUITMENT_BRIEF', 'ACADEMY_PROSPECT', 'MATCH_REPORT');

-- CreateEnum
CREATE TYPE "VisionAuditCategory" AS ENUM ('INGEST', 'INFERENCE', 'TRACKING', 'EVENTS', 'ANALYTICS', 'FUSION', 'CLIP', 'SCOUTING', 'REALTIME', 'OVERRIDE', 'ACCESS', 'OTHER');

-- CreateEnum
CREATE TYPE "VisionAuditResult" AS ENUM ('SUCCESS', 'FAILURE', 'REJECTED');

-- CreateEnum
CREATE TYPE "ExecutiveRole" AS ENUM ('CEO', 'CFO', 'COO', 'CHAIR', 'BOARD_MEMBER', 'INVESTOR_LEAD', 'COUNSEL', 'STRATEGIC_ADVISOR');

-- CreateEnum
CREATE TYPE "ExecutiveWorkflowKind" AS ENUM ('SPONSOR_ONBOARDING', 'ACQUISITION', 'TERRITORY_EXPANSION', 'CAPITAL_DEPLOYMENT', 'RISK_INTERVENTION', 'PARTNERSHIP', 'PLATFORM_LAUNCH', 'STRATEGIC_INITIATIVE', 'GOVERNANCE_ACTION', 'CUSTOM');

-- CreateEnum
CREATE TYPE "ExecutiveWorkflowStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'AWAITING_APPROVAL', 'APPROVED', 'IN_EXECUTION', 'COMPLETED', 'REJECTED', 'CANCELLED', 'STALLED');

-- CreateEnum
CREATE TYPE "ExecutivePriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "ExecutiveStepStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'SKIPPED', 'BLOCKED', 'REQUIRES_HUMAN');

-- CreateEnum
CREATE TYPE "AttestationDecision" AS ENUM ('APPROVE', 'REJECT', 'ABSTAIN');

-- CreateEnum
CREATE TYPE "BoardResolutionStatus" AS ENUM ('DRAFT', 'CIRCULATING', 'VOTING', 'PASSED', 'FAILED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "BoardVoteDecision" AS ENUM ('FOR', 'AGAINST', 'ABSTAIN');

-- CreateEnum
CREATE TYPE "SponsorTier" AS ENUM ('PRINCIPAL', 'PLATINUM', 'GOLD', 'SILVER', 'BRONZE', 'COMMUNITY');

-- CreateEnum
CREATE TYPE "SponsorPipelineStage" AS ENUM ('PROSPECT', 'QUALIFIED', 'PROPOSAL_SENT', 'IN_NEGOTIATION', 'CONTRACT_SIGNED', 'ACTIVE', 'RENEWAL', 'CHURNED', 'REJECTED');

-- CreateEnum
CREATE TYPE "RiskCategory" AS ENUM ('FINANCIAL', 'OPERATIONAL', 'LEGAL', 'REPUTATIONAL', 'STRATEGIC', 'TECHNICAL', 'REGULATORY');

-- CreateEnum
CREATE TYPE "RiskSeverity" AS ENUM ('INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "RiskAlertStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'MITIGATING', 'RESOLVED', 'WAIVED', 'ESCALATED');

-- CreateEnum
CREATE TYPE "ForecastScope" AS ENUM ('PLATFORM', 'FRANCHISE_UNIT', 'CLUB', 'INVESTMENT_ENTITY');

-- CreateEnum
CREATE TYPE "ForecastScenario" AS ENUM ('BASE', 'OPTIMISTIC', 'PESSIMISTIC', 'STRESS');

-- CreateEnum
CREATE TYPE "ExecutiveAuditCategory" AS ENUM ('WORKFLOW', 'ATTESTATION', 'BOARD', 'SPONSOR', 'FORECAST', 'RISK', 'ACCESS', 'AGGREGATE', 'OTHER');

-- CreateEnum
CREATE TYPE "ExecutiveAuditResult" AS ENUM ('SUCCESS', 'FAILURE', 'REJECTED');

-- CreateTable
CREATE TABLE "Club" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shortName" TEXT,
    "emblem" TEXT,
    "city" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'Germany',
    "founded" TIMESTAMP(3),
    "stadium" TEXT,
    "capacity" INTEGER,
    "level" INTEGER NOT NULL DEFAULT 1,
    "overallRating" DOUBLE PRECISION NOT NULL DEFAULT 70.0,
    "leaguePosition" INTEGER,
    "fanClub" TEXT,
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "plan" "SubscriptionPlan" NOT NULL DEFAULT 'BASIC',
    "subscriptionStatus" "SubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
    "trialEndsAt" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "planSource" "PlanSource" NOT NULL DEFAULT 'STRIPE',
    "franchiseUnitId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Club_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'HEAD_COACH',
    "avatar" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "clubId" TEXT NOT NULL,
    "currentClubId" TEXT,
    "currentTeamId" TEXT,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Player" (
    "id" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "position" "PlayerPosition" NOT NULL,
    "nationality" TEXT NOT NULL,
    "flag" TEXT NOT NULL,
    "dateOfBirth" TIMESTAMP(3) NOT NULL,
    "height" INTEGER NOT NULL,
    "weight" INTEGER NOT NULL,
    "preferredFoot" "Foot" NOT NULL DEFAULT 'RIGHT',
    "overallRating" INTEGER NOT NULL DEFAULT 70,
    "potential" INTEGER NOT NULL DEFAULT 70,
    "condition" INTEGER NOT NULL DEFAULT 100,
    "isInjured" BOOLEAN NOT NULL DEFAULT false,
    "marketValue" DOUBLE PRECISION NOT NULL DEFAULT 1000000,
    "weeklyWage" INTEGER NOT NULL DEFAULT 10000,
    "contractUntil" TIMESTAMP(3),
    "avatar" TEXT,
    "email" TEXT,
    "parentName" TEXT,
    "parentEmail" TEXT,
    "parentPhone" TEXT,
    "medicalStatus" "MedicalStatus" NOT NULL DEFAULT 'HEALTHY',
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'PAID',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clubId" TEXT NOT NULL,
    "teamId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Player_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayerAuditLog" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "userId" TEXT,
    "action" "PlayerAuditAction" NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlayerAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shortName" TEXT,
    "kind" "TeamKind" NOT NULL DEFAULT 'SENIOR',
    "gender" "Gender" NOT NULL DEFAULT 'MIXED',
    "ageMin" INTEGER,
    "ageMax" INTEGER,
    "color" TEXT,
    "emblem" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "teamId" TEXT,
    "role" "MembershipRole" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MembershipAuditLog" (
    "id" TEXT NOT NULL,
    "membershipId" TEXT,
    "clubId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "action" "MembershipAuditAction" NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MembershipAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayerAttribute" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "reflexes" INTEGER,
    "gkPositioning" INTEGER,
    "handling" INTEGER,
    "kicking" INTEGER,
    "tackling" INTEGER,
    "marking" INTEGER,
    "heading" INTEGER,
    "defPositioning" INTEGER,
    "interceptions" INTEGER,
    "pace" INTEGER,
    "shooting" INTEGER,
    "passing" INTEGER,
    "dribbling" INTEGER,
    "crossing" INTEGER,
    "strength" INTEGER,
    "stamina" INTEGER,
    "agility" INTEGER,
    "balance" INTEGER,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlayerAttribute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayerGpsData" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "sessionId" TEXT,
    "sessionType" TEXT,
    "topSpeed" DOUBLE PRECISION NOT NULL,
    "avgSpeed" DOUBLE PRECISION NOT NULL,
    "distance" DOUBLE PRECISION NOT NULL,
    "sprintCount" INTEGER NOT NULL,
    "heartRateAvg" INTEGER NOT NULL,
    "heartRateMax" INTEGER NOT NULL,
    "playerLoad" DOUBLE PRECISION NOT NULL,
    "riskScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlayerGpsData_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayerInjury" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "bodyPart" TEXT NOT NULL,
    "injuryType" TEXT NOT NULL,
    "severity" "InjurySeverity" NOT NULL,
    "injuredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expectedReturn" TIMESTAMP(3),
    "returnedAt" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "PlayerInjury_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Match" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "teamId" TEXT,
    "status" "MatchStatus" NOT NULL DEFAULT 'SCHEDULED',
    "periodNow" INTEGER,
    "liveStartedAt" TIMESTAMP(3),
    "liveMinute" INTEGER,
    "formationHome" TEXT,
    "formationAway" TEXT,
    "opponentNotes" TEXT,
    "aiInsights" JSONB,
    "deviceSessionId" TEXT,
    "homeTeam" TEXT NOT NULL,
    "awayTeam" TEXT NOT NULL,
    "homeScore" INTEGER,
    "awayScore" INTEGER,
    "isHome" BOOLEAN NOT NULL DEFAULT true,
    "competition" "CompetitionType" NOT NULL DEFAULT 'LEAGUE',
    "competitionName" TEXT,
    "result" "MatchResult",
    "venue" TEXT,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "playedAt" TIMESTAMP(3),
    "possession" DOUBLE PRECISION,
    "shots" INTEGER,
    "shotsOnTarget" INTEGER,
    "corners" INTEGER,
    "fouls" INTEGER,
    "yellowCards" INTEGER,
    "redCards" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Match_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayerMatchStat" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "minutesPlayed" INTEGER NOT NULL DEFAULT 0,
    "goals" INTEGER NOT NULL DEFAULT 0,
    "assists" INTEGER NOT NULL DEFAULT 0,
    "shots" INTEGER NOT NULL DEFAULT 0,
    "passes" INTEGER NOT NULL DEFAULT 0,
    "passAccuracy" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tackles" INTEGER NOT NULL DEFAULT 0,
    "rating" DOUBLE PRECISION,

    CONSTRAINT "PlayerMatchStat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchLineup" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "side" "MatchSide" NOT NULL,
    "formation" TEXT,
    "notes" TEXT,
    "positions" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MatchLineup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchTimeline" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "occurredAtMin" INTEGER NOT NULL,
    "occurredAtSec" INTEGER,
    "period" INTEGER NOT NULL DEFAULT 1,
    "kind" "MatchTimelineKind" NOT NULL,
    "side" "MatchSide" NOT NULL,
    "primaryPlayerId" TEXT,
    "secondaryPlayerId" TEXT,
    "opponentName" TEXT,
    "pitchX" DOUBLE PRECISION,
    "pitchY" DOUBLE PRECISION,
    "notes" TEXT,
    "payload" JSONB,
    "enteredByUserId" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MatchTimeline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchTacticalSnapshot" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "takenAtMin" INTEGER NOT NULL,
    "period" INTEGER NOT NULL DEFAULT 1,
    "phase" "MatchTacticalPhase" NOT NULL DEFAULT 'OPEN_PLAY',
    "formation" TEXT,
    "possession" DOUBLE PRECISION,
    "positions" JSONB NOT NULL,
    "notes" TEXT,
    "source" "TacticalSource" NOT NULL DEFAULT 'MANUAL',
    "authorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MatchTacticalSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchAuditLog" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "userId" TEXT,
    "action" "MatchAuditAction" NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MatchAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceSession" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "teamId" TEXT,
    "matchId" TEXT,
    "trainingSessionId" TEXT,
    "deviceModel" TEXT NOT NULL,
    "deviceSerial" TEXT NOT NULL,
    "edgeFwVersion" TEXT,
    "sessionKey" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SensorPacket" (
    "id" TEXT NOT NULL,
    "deviceSessionId" TEXT NOT NULL,
    "kind" "SensorPacketKind" NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB NOT NULL,
    "sigB64" TEXT,

    CONSTRAINT "SensorPacket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationTask" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "teamId" TEXT,
    "kind" "AutomationKind" NOT NULL,
    "name" TEXT NOT NULL,
    "schedule" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "budgetCents" INTEGER NOT NULL DEFAULT 0,
    "params" JSONB,
    "lastRunAt" TIMESTAMP(3),
    "lastStatus" "AutomationStatus",
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRun" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" "AutomationStatus" NOT NULL DEFAULT 'PENDING',
    "output" JSONB,
    "error" TEXT,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "costTokens" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AutomationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIAgentJob" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "teamId" TEXT,
    "agent" "AIAgent" NOT NULL,
    "kind" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "output" JSONB,
    "status" "AutomationStatus" NOT NULL DEFAULT 'PENDING',
    "model" TEXT,
    "costTokens" INTEGER NOT NULL DEFAULT 0,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "triggeredBy" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIAgentJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIAlert" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "matchId" TEXT,
    "teamId" TEXT,
    "playerId" TEXT,
    "agent" "AIAgent",
    "kind" TEXT NOT NULL,
    "severity" "AlertSeverity" NOT NULL DEFAULT 'INFO',
    "title" TEXT NOT NULL DEFAULT '',
    "message" TEXT,
    "payload" JSONB,
    "status" "AlertStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ackedAt" TIMESTAMP(3),
    "ackedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "AIAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIRecommendation" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "matchId" TEXT,
    "teamId" TEXT,
    "playerId" TEXT,
    "agent" "AIAgent" NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "content" JSONB NOT NULL,
    "score" DOUBLE PRECISION,
    "status" "AlertStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ackedAt" TIMESTAMP(3),
    "ackedBy" TEXT,

    CONSTRAINT "AIRecommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIReport" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "matchId" TEXT,
    "teamId" TEXT,
    "agent" "AIAgent" NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DigitalTwinFrame" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "takenAtMs" BIGINT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'TACTICAL',
    "version" INTEGER NOT NULL DEFAULT 1,
    "state" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DigitalTwinFrame_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "teamId" TEXT,
    "serial" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "hwRevision" TEXT,
    "hmacSecret" TEXT NOT NULL,
    "efuseFingerprint" TEXT,
    "status" "DeviceProvisionStatus" NOT NULL DEFAULT 'REGISTERED',
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "notes" TEXT,
    "metadata" JSONB,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceFirmware" (
    "id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'stable',
    "version" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "downloadUrl" TEXT NOT NULL,
    "minHwRev" TEXT,
    "notes" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedBy" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "DeviceFirmware_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceCalibration" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "sensorKind" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "payload" JSONB NOT NULL,
    "appliedBy" TEXT,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "DeviceCalibration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventOutbox" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "matchId" TEXT,
    "seq" BIGINT NOT NULL,
    "kind" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "adapters" TEXT,

    CONSTRAINT "EventOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchEventSequence" (
    "matchId" TEXT NOT NULL,
    "next" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "MatchEventSequence_pkey" PRIMARY KEY ("matchId")
);

-- CreateTable
CREATE TABLE "Camera" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "teamId" TEXT,
    "serial" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" "CameraKind" NOT NULL DEFAULT 'RGB',
    "vendor" TEXT,
    "model" TEXT,
    "hwRevision" TEXT,
    "hmacSecret" TEXT NOT NULL,
    "status" "CameraStatus" NOT NULL DEFAULT 'REGISTERED',
    "lastClockSkewMs" INTEGER,
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "calibratedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "metadata" JSONB,

    CONSTRAINT "Camera_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CameraCalibration" (
    "id" TEXT NOT NULL,
    "cameraId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "intrinsics" JSONB NOT NULL,
    "extrinsics" JSONB NOT NULL,
    "frameOfReference" TEXT NOT NULL DEFAULT 'PITCH',
    "reprojectionErrorPx" DOUBLE PRECISION,
    "appliedBy" TEXT,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "CameraCalibration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisionFrame" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "matchId" TEXT,
    "cameraId" TEXT NOT NULL,
    "monotonicMs" BIGINT NOT NULL,
    "cameraTsUs" BIGINT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'RGB',
    "detections" JSONB NOT NULL,
    "calibrationVersion" INTEGER,
    "sigB64" TEXT,

    CONSTRAINT "VisionFrame_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SpatialFrame" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "monotonicMs" BIGINT NOT NULL,
    "sport" "SportKind" NOT NULL DEFAULT 'FOOTBALL',
    "players" JSONB NOT NULL,
    "object" JSONB,
    "geometry" JSONB,
    "sources" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SpatialFrame_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TacticalAnnotation" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "atMs" BIGINT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'CLUB',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "TacticalAnnotation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Prediction" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "matchId" TEXT,
    "teamId" TEXT,
    "playerId" TEXT,
    "kind" "PredictionKind" NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "horizonMs" INTEGER NOT NULL DEFAULT 300000,
    "components" JSONB NOT NULL,
    "rationale" TEXT,
    "modelVersion" TEXT NOT NULL DEFAULT 'v1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Prediction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityAuditEvent" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "chainPosition" BIGINT NOT NULL,
    "actorId" TEXT,
    "teamId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "payloadHash" TEXT NOT NULL,
    "previousHash" TEXT NOT NULL,
    "currentHash" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityChainHead" (
    "clubId" TEXT NOT NULL,
    "nextPosition" BIGINT NOT NULL DEFAULT 0,
    "lastHash" TEXT NOT NULL DEFAULT 'GENESIS',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecurityChainHead_pkey" PRIMARY KEY ("clubId")
);

-- CreateTable
CREATE TABLE "SecurityEvent" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "actorId" TEXT,
    "kind" "SecurityEventKind" NOT NULL,
    "severity" "SecuritySeverity" NOT NULL DEFAULT 'INFO',
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginAttempt" (
    "id" TEXT NOT NULL,
    "emailHash" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIApprovalRequest" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "agent" "AIAgent" NOT NULL,
    "kind" "AIApprovalKind" NOT NULL,
    "jobId" TEXT,
    "payload" JSONB NOT NULL,
    "status" "AIApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedReason" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIApprovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceSecurityEvent" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "deviceSessionId" TEXT,
    "cameraId" TEXT,
    "kind" "SecurityEventKind" NOT NULL,
    "severity" "SecuritySeverity" NOT NULL DEFAULT 'WARN',
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceSecurityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Region" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "anchorCity" TEXT,
    "countries" JSONB,
    "status" "RegionStatus" NOT NULL DEFAULT 'ACTIVE',
    "primary" BOOLEAN NOT NULL DEFAULT false,
    "failoverCode" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Region_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegionNode" (
    "id" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "kind" "RegionNodeKind" NOT NULL,
    "url" TEXT,
    "version" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "RegionStatus" NOT NULL DEFAULT 'ACTIVE',
    "metadata" JSONB,

    CONSTRAINT "RegionNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegionHeartbeat" (
    "id" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "healthScore" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "cpuLoad" DOUBLE PRECISION,
    "memMb" INTEGER,
    "activeSubs" INTEGER DEFAULT 0,
    "queueDepth" INTEGER DEFAULT 0,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegionHeartbeat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegionHealth" (
    "regionId" TEXT NOT NULL,
    "healthyNodes" INTEGER NOT NULL DEFAULT 0,
    "totalNodes" INTEGER NOT NULL DEFAULT 0,
    "meanScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lastIncidentAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegionHealth_pkey" PRIMARY KEY ("regionId")
);

-- CreateTable
CREATE TABLE "DistributedEventCursor" (
    "id" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "adapter" TEXT NOT NULL,
    "topic" TEXT,
    "lastSeq" BIGINT NOT NULL DEFAULT 0,
    "lastTs" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DistributedEventCursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIAgentDecision" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "matchId" TEXT,
    "teamId" TEXT,
    "agent" "AIAgent" NOT NULL,
    "kind" TEXT NOT NULL,
    "jobId" TEXT,
    "rationale" TEXT NOT NULL,
    "sourceTelemetry" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "tacticalImpact" "AIDecisionImpact" NOT NULL DEFAULT 'LOW',
    "approvalRequestId" TEXT,
    "payload" JSONB,
    "payloadHash" TEXT,
    "modelVersion" TEXT NOT NULL DEFAULT 'v1',
    "backend" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIAgentDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TacticalGhost" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "sourceSpatialFrameId" TEXT,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TacticalGhost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplayCursor" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "atMs" BIGINT NOT NULL,
    "rate" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReplayCursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PoseSkeleton" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "matchId" TEXT,
    "visionFrameId" TEXT,
    "playerId" TEXT,
    "monotonicMs" BIGINT NOT NULL,
    "joints" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PoseSkeleton_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BallTrajectory" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "points" JSONB NOT NULL,
    "fromMs" BIGINT NOT NULL,
    "toMs" BIGINT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "sourceFrameIds" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BallTrajectory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SpatialMap" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "matchId" TEXT,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "windowMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SpatialMap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EdgeNode" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "teamId" TEXT,
    "kind" "EdgeNodeKind" NOT NULL,
    "deviceId" TEXT,
    "cameraId" TEXT,
    "label" TEXT,
    "fwVersion" TEXT,
    "compression" "CompressionStrategy" NOT NULL DEFAULT 'NONE',
    "status" "RegionStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastSyncAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EdgeNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EdgeBuffer" (
    "id" TEXT NOT NULL,
    "edgeNodeId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3),
    "packetCount" INTEGER NOT NULL DEFAULT 1,
    "compression" "CompressionStrategy" NOT NULL DEFAULT 'NONE',

    CONSTRAINT "EdgeBuffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncWindow" (
    "id" TEXT NOT NULL,
    "edgeNodeId" TEXT NOT NULL,
    "fromMs" BIGINT NOT NULL,
    "toMs" BIGINT NOT NULL,
    "packetsTotal" INTEGER NOT NULL DEFAULT 0,
    "packetsOk" INTEGER NOT NULL DEFAULT 0,
    "ok" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncWindow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EdgeInferenceResult" (
    "id" TEXT NOT NULL,
    "edgeNodeId" TEXT NOT NULL,
    "clubId" TEXT,
    "matchId" TEXT,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EdgeInferenceResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProvisioningBatch" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "factoryRef" TEXT,
    "model" TEXT NOT NULL,
    "hwRevision" TEXT,
    "serials" JSONB NOT NULL,
    "status" "ProvisioningStatus" NOT NULL DEFAULT 'CREATED',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "manifestId" TEXT,
    "createdById" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProvisioningBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceCertificate" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "issuer" TEXT,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validUntil" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "metadata" JSONB,

    CONSTRAINT "DeviceCertificate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FirmwareManifest" (
    "id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'stable',
    "version" TEXT NOT NULL,
    "files" JSONB NOT NULL,
    "releaseNotes" TEXT,
    "minHwRev" TEXT,
    "publishedBy" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "FirmwareManifest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceActivation" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "batchId" TEXT,
    "serial" TEXT NOT NULL,
    "activatedAt" TIMESTAMP(3),
    "ipAddress" TEXT,
    "fingerprint" TEXT,
    "status" "ProvisioningStatus" NOT NULL DEFAULT 'CREATED',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceActivation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OTARelease" (
    "id" TEXT NOT NULL,
    "manifestId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'stable',
    "version" TEXT NOT NULL,
    "rolloutPct" INTEGER NOT NULL DEFAULT 0,
    "scheduledAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "status" "ProvisioningStatus" NOT NULL DEFAULT 'CREATED',
    "notes" TEXT,

    CONSTRAINT "OTARelease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingPlanTier" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "kind" "BillingPlanKind" NOT NULL,
    "label" TEXT NOT NULL,
    "monthlyCents" INTEGER NOT NULL DEFAULT 0,
    "features" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingPlanTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingAccount" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "planTierId" TEXT NOT NULL,
    "status" "BillingAccountStatus" NOT NULL DEFAULT 'TRIAL',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "renewsAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "externalRef" TEXT,
    "metadata" JSONB,

    CONSTRAINT "BillingAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DevicePlanAssignment" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "planTierId" TEXT NOT NULL,
    "status" "BillingAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "DevicePlanAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageMeter" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "count" BIGINT NOT NULL DEFAULT 0,
    "period" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "UsageMeter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceDraft" (
    "id" TEXT NOT NULL,
    "billingAccountId" TEXT NOT NULL,
    "periodFrom" TIMESTAMP(3) NOT NULL,
    "periodTo" TIMESTAMP(3) NOT NULL,
    "amountCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "status" "BillingAccountStatus" NOT NULL DEFAULT 'TRIAL',
    "lineItems" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemMetric" (
    "id" TEXT NOT NULL,
    "regionId" TEXT,
    "name" TEXT NOT NULL,
    "kind" "MetricKind" NOT NULL DEFAULT 'GAUGE',
    "value" DOUBLE PRECISION NOT NULL,
    "label" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceHealth" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "lastPacketAt" TIMESTAMP(3),
    "batteryPct" INTEGER,
    "signalDbm" INTEGER,
    "notes" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceHealth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RealtimeHealth" (
    "id" TEXT NOT NULL,
    "regionId" TEXT,
    "kind" TEXT NOT NULL,
    "activeSubs" INTEGER NOT NULL DEFAULT 0,
    "queueDepth" INTEGER NOT NULL DEFAULT 0,
    "errors1m" INTEGER NOT NULL DEFAULT 0,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RealtimeHealth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIWorkerHealth" (
    "id" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "regionId" TEXT,
    "lastTickAt" TIMESTAMP(3),
    "jobsPerMin" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "failuresPerMin" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIWorkerHealth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplayIntegrityMetric" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "expectedSeq" BIGINT NOT NULL,
    "actualSeq" BIGINT NOT NULL,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "brokenAt" BIGINT,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReplayIntegrityMetric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventCameraStream" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "cameraId" TEXT NOT NULL,
    "matchId" TEXT,
    "sessionRef" TEXT NOT NULL,
    "status" "VisionStreamStatus" NOT NULL DEFAULT 'ACTIVE',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "packetsTotal" BIGINT NOT NULL DEFAULT 0,
    "eventsTotal" BIGINT NOT NULL DEFAULT 0,
    "syncVersion" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,

    CONSTRAINT "EventCameraStream_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisionEventBatch" (
    "id" TEXT NOT NULL,
    "streamId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "matchId" TEXT,
    "monotonicMs" BIGINT NOT NULL,
    "cameraTsUs" BIGINT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'AGGREGATED',
    "events" JSONB NOT NULL,
    "eventCount" INTEGER NOT NULL DEFAULT 0,
    "sigB64" TEXT,
    "nonce" TEXT,

    CONSTRAINT "VisionEventBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventPoseEstimate" (
    "id" TEXT NOT NULL,
    "streamId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "matchId" TEXT,
    "playerId" TEXT,
    "monotonicMs" BIGINT NOT NULL,
    "joints" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventPoseEstimate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventMotionCluster" (
    "id" TEXT NOT NULL,
    "streamId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "matchId" TEXT,
    "monotonicMs" BIGINT NOT NULL,
    "centroidX" DOUBLE PRECISION NOT NULL,
    "centroidY" DOUBLE PRECISION NOT NULL,
    "radius" DOUBLE PRECISION NOT NULL,
    "density" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "polarity" INTEGER NOT NULL DEFAULT 0,
    "subjectKind" "VisionSubjectKind" NOT NULL DEFAULT 'UNKNOWN',
    "subjectId" TEXT,
    "latencyUs" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventMotionCluster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisionTimestampSync" (
    "id" TEXT NOT NULL,
    "cameraId" TEXT NOT NULL,
    "sessionRef" TEXT NOT NULL,
    "deviceUs" BIGINT NOT NULL,
    "serverRxMs" BIGINT NOT NULL,
    "skewMs" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "jitterMs" DOUBLE PRECISION,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VisionTimestampSync_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CameraRig" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "syncStrategy" "CameraRigSyncStrategy" NOT NULL DEFAULT 'NTP',
    "geometry" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CameraRig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CameraRigMember" (
    "id" TEXT NOT NULL,
    "rigId" TEXT NOT NULL,
    "cameraId" TEXT NOT NULL,
    "role" "CameraRigRole" NOT NULL DEFAULT 'GENERIC',
    "position" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CameraRigMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CameraSyncSession" (
    "id" TEXT NOT NULL,
    "rigId" TEXT NOT NULL,
    "matchId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "anchorTsUs" BIGINT,
    "skews" JSONB,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,

    CONSTRAINT "CameraSyncSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MultiCameraObservation" (
    "id" TEXT NOT NULL,
    "syncSessionId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "matchId" TEXT,
    "monotonicMs" BIGINT NOT NULL,
    "subjectKind" "VisionSubjectKind" NOT NULL DEFAULT 'UNKNOWN',
    "subjectId" TEXT,
    "contributingCameras" JSONB NOT NULL,
    "triangulationResultId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MultiCameraObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SpatialTriangulationResult" (
    "id" TEXT NOT NULL,
    "syncSessionId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "matchId" TEXT,
    "monotonicMs" BIGINT NOT NULL,
    "subjectKind" "VisionSubjectKind" NOT NULL DEFAULT 'UNKNOWN',
    "subjectId" TEXT,
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "z" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "votes" INTEGER NOT NULL DEFAULT 0,
    "residualMeanM" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SpatialTriangulationResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisualTacticalSignal" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "signalKind" "TacticalSignalKind" NOT NULL,
    "monotonicMs" BIGINT NOT NULL,
    "side" TEXT NOT NULL DEFAULT 'NEUTRAL',
    "intensity" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "payload" JSONB NOT NULL,
    "detectorVersion" TEXT NOT NULL DEFAULT 'v1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VisualTacticalSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TacticalPatternDetection" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "monotonicMs" BIGINT NOT NULL,
    "patternKind" TEXT NOT NULL,
    "contributingSignalIds" JSONB NOT NULL,
    "intensity" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "rationale" TEXT,
    "detectorVersion" TEXT NOT NULL DEFAULT 'v1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TacticalPatternDetection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisualFormationState" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "monotonicMs" BIGINT NOT NULL,
    "side" TEXT NOT NULL DEFAULT 'HOME',
    "formation" TEXT NOT NULL,
    "spotsPayload" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "detectorVersion" TEXT NOT NULL DEFAULT 'v1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VisualFormationState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PressingIntensityEstimate" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "monotonicMs" BIGINT NOT NULL,
    "side" TEXT NOT NULL DEFAULT 'HOME',
    "intensity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "synchronyIndex" DOUBLE PRECISION,
    "pressureMass" DOUBLE PRECISION,
    "detectorVersion" TEXT NOT NULL DEFAULT 'v1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PressingIntensityEstimate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DefensiveLineEstimate" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "monotonicMs" BIGINT NOT NULL,
    "side" TEXT NOT NULL DEFAULT 'HOME',
    "lineX" DOUBLE PRECISION NOT NULL,
    "spreadY" DOUBLE PRECISION NOT NULL,
    "stabilityIndex" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "detectorVersion" TEXT NOT NULL DEFAULT 'v1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DefensiveLineEstimate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OverloadZoneEstimate" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "monotonicMs" BIGINT NOT NULL,
    "zoneX" DOUBLE PRECISION NOT NULL,
    "zoneY" DOUBLE PRECISION NOT NULL,
    "homeCount" INTEGER NOT NULL DEFAULT 0,
    "awayCount" INTEGER NOT NULL DEFAULT 0,
    "delta" INTEGER NOT NULL DEFAULT 0,
    "intensity" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "detectorVersion" TEXT NOT NULL DEFAULT 'v1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OverloadZoneEstimate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EdgeVisionRuntime" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "edgeNodeId" TEXT,
    "cameraId" TEXT,
    "label" TEXT NOT NULL,
    "fwVersion" TEXT,
    "os" TEXT,
    "hwClass" TEXT,
    "status" "EdgeVisionRuntimeStatus" NOT NULL DEFAULT 'PROVISIONED',
    "lastSeenAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EdgeVisionRuntime_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EdgeModelManifest" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EdgeModelManifest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EdgeModelVersion" (
    "id" TEXT NOT NULL,
    "manifestId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "downloadUrl" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "EdgeModelVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EdgeVisionInference" (
    "id" TEXT NOT NULL,
    "runtimeId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "matchId" TEXT,
    "cameraId" TEXT,
    "modelVersionId" TEXT,
    "monotonicMs" BIGINT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "latencyMs" INTEGER,
    "sigB64" TEXT,
    "nonce" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EdgeVisionInference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EdgeVisionHealth" (
    "id" TEXT NOT NULL,
    "runtimeId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "latencyP95Ms" INTEGER,
    "jobsPerMin" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "failuresPerMin" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EdgeVisionHealth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BiomechanicalPacket" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "matchId" TEXT,
    "playerId" TEXT,
    "deviceId" TEXT,
    "monotonicMs" BIGINT NOT NULL,
    "deviceTsMs" BIGINT NOT NULL,
    "lactateMmol" DOUBLE PRECISION,
    "glucoseMg" DOUBLE PRECISION,
    "hydrationPct" DOUBLE PRECISION,
    "cortisolProxy" DOUBLE PRECISION,
    "payload" JSONB,
    "sigB64" TEXT,
    "nonce" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BiomechanicalPacket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HardwareProvisioningSession" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "batchId" TEXT,
    "deviceId" TEXT,
    "serial" TEXT NOT NULL,
    "status" "HardwareProvisioningStatus" NOT NULL DEFAULT 'CREATED',
    "steps" JSONB NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HardwareProvisioningSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceCapabilityProfile" (
    "id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "hwRevision" TEXT,
    "capabilities" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "publishedBy" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceCapabilityProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceSensorMatrix" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "matrix" JSONB NOT NULL,
    "publishedBy" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "DeviceSensorMatrix_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceClockDiscipline" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "strategy" TEXT NOT NULL,
    "lastSkewMs" DOUBLE PRECISION,
    "jitterMs" DOUBLE PRECISION,
    "source" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceClockDiscipline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceTrustAnchor" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "certFingerprint" TEXT NOT NULL,
    "secureBootHash" TEXT,
    "hwSerial" TEXT,
    "issuer" TEXT,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validUntil" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastAttestationStatus" "AttestationStatus" NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "DeviceTrustAnchor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceAttestation" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "trustAnchorId" TEXT,
    "fwVersion" TEXT,
    "secureBootHash" TEXT,
    "nonce" TEXT NOT NULL,
    "sigB64" TEXT NOT NULL,
    "status" "AttestationStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceAttestation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FederatedTrainingJob" (
    "id" TEXT NOT NULL,
    "initiatorClubId" TEXT,
    "sport" "SportKind" NOT NULL DEFAULT 'FOOTBALL',
    "modelFamily" TEXT NOT NULL,
    "roundNumber" INTEGER NOT NULL DEFAULT 0,
    "aggregationSeed" BIGINT NOT NULL,
    "privacyBoundaryId" TEXT,
    "clippingNormMax" DOUBLE PRECISION,
    "status" "FederatedJobStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FederatedTrainingJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FederatedGradientEnvelope" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "blobRef" TEXT,
    "nonce" TEXT NOT NULL,
    "sigB64" TEXT,
    "normValue" DOUBLE PRECISION,
    "acceptedAt" TIMESTAMP(3),
    "rejectedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FederatedGradientEnvelope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FederatedModelCheckpoint" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "blobRef" TEXT,
    "participants" INTEGER NOT NULL DEFAULT 0,
    "participantOrder" JSONB NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FederatedModelCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubModelPartition" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "modelFamily" TEXT NOT NULL,
    "partitionKey" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClubModelPartition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrivacyBoundary" (
    "id" TEXT NOT NULL,
    "modelFamily" TEXT NOT NULL,
    "dpEpsilon" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "kAnonymity" INTEGER NOT NULL DEFAULT 5,
    "aggregationOnly" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "PrivacyBoundary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AggregatedSportsModel" (
    "id" TEXT NOT NULL,
    "modelFamily" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "downloadUrl" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "AggregatedSportsModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FederatedTrustBoundary" (
    "id" TEXT NOT NULL,
    "modelFamily" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "trusted" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FederatedTrustBoundary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoachAgent" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "agentKind" "AIAgent" NOT NULL,
    "config" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoachAgent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoachRecommendation" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "matchId" TEXT,
    "teamId" TEXT,
    "playerId" TEXT,
    "agentId" TEXT,
    "kind" "CoachRecommendationKind" NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "rationale" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "tacticalImpact" "AIDecisionImpact" NOT NULL DEFAULT 'LOW',
    "approvalRequestId" TEXT,
    "payloadHash" TEXT,
    "detectorVersion" TEXT NOT NULL DEFAULT 'l1',
    "status" "AlertStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ackedAt" TIMESTAMP(3),
    "ackedBy" TEXT,

    CONSTRAINT "CoachRecommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TwinSimulationSession" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "matchId" TEXT,
    "label" TEXT NOT NULL,
    "seed" BIGINT NOT NULL,
    "status" "SimulationStatus" NOT NULL DEFAULT 'DRAFT',
    "sourceFrameId" TEXT,
    "rootBranchId" TEXT,
    "createdById" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TwinSimulationSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchSimulationState" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "branchId" TEXT,
    "tickMs" BIGINT NOT NULL,
    "state" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MatchSimulationState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TacticalBranch" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "parentBranchId" TEXT,
    "label" TEXT NOT NULL,
    "divergencePayload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TacticalBranch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PredictedPossessionFlow" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "series" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PredictedPossessionFlow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PredictedFatigueCurve" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "series" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PredictedFatigueCurve_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CounterfactualScenario" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "branchId" TEXT,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "outcome" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CounterfactualScenario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GameGraph" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "monotonicMs" BIGINT NOT NULL,
    "nodes" JSONB NOT NULL,
    "edges" JSONB NOT NULL,
    "detectorVersion" TEXT NOT NULL DEFAULT 'l1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GameGraph_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SpatialPressureGraph" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "monotonicMs" BIGINT NOT NULL,
    "field" JSONB NOT NULL,
    "windowMs" INTEGER NOT NULL DEFAULT 5000,
    "detectorVersion" TEXT NOT NULL DEFAULT 'l1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SpatialPressureGraph_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PassingNetworkGraph" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "monotonicMs" BIGINT NOT NULL,
    "network" JSONB NOT NULL,
    "windowMs" INTEGER NOT NULL DEFAULT 300000,
    "detectorVersion" TEXT NOT NULL DEFAULT 'l1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PassingNetworkGraph_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DynamicThreatMap" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "monotonicMs" BIGINT NOT NULL,
    "field" JSONB NOT NULL,
    "windowMs" INTEGER NOT NULL DEFAULT 60000,
    "detectorVersion" TEXT NOT NULL DEFAULT 'l1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DynamicThreatMap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CognitiveInfluenceScore" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "monotonicMs" BIGINT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "components" JSONB,
    "detectorVersion" TEXT NOT NULL DEFAULT 'l1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CognitiveInfluenceScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BiochemicalSignal" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "playerId" TEXT,
    "matchId" TEXT,
    "kind" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "unit" TEXT,
    "monotonicMs" BIGINT NOT NULL,
    "sourceDeviceId" TEXT,
    "detectorVersion" TEXT NOT NULL DEFAULT 'l1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BiochemicalSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HydrationEstimate" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "matchId" TEXT,
    "monotonicMs" BIGINT NOT NULL,
    "estimatePct" DOUBLE PRECISION NOT NULL DEFAULT 100,
    "components" JSONB,
    "detectorVersion" TEXT NOT NULL DEFAULT 'l1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HydrationEstimate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StressIndex" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "matchId" TEXT,
    "monotonicMs" BIGINT NOT NULL,
    "index" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "components" JSONB,
    "detectorVersion" TEXT NOT NULL DEFAULT 'l1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StressIndex_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NeuromuscularLoad" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "matchId" TEXT,
    "monotonicMs" BIGINT NOT NULL,
    "load" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "asymmetry" DOUBLE PRECISION,
    "components" JSONB,
    "detectorVersion" TEXT NOT NULL DEFAULT 'l1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NeuromuscularLoad_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TendonRiskEstimate" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "matchId" TEXT,
    "monotonicMs" BIGINT NOT NULL,
    "risk" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "region" TEXT,
    "components" JSONB,
    "detectorVersion" TEXT NOT NULL DEFAULT 'l1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TendonRiskEstimate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SportPlugin" (
    "id" TEXT NOT NULL,
    "sport" "SportKind" NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "publishedBy" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SportPlugin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TacticalDomain" (
    "id" TEXT NOT NULL,
    "sport" "SportKind" NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "parentCode" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TacticalDomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SportFieldGeometry" (
    "id" TEXT NOT NULL,
    "sport" "SportKind" NOT NULL,
    "pluginCode" TEXT,
    "widthM" DOUBLE PRECISION NOT NULL,
    "heightM" DOUBLE PRECISION NOT NULL,
    "zones" JSONB,
    "targets" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SportFieldGeometry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SportEventTaxonomy" (
    "id" TEXT NOT NULL,
    "sport" "SportKind" NOT NULL,
    "eventKind" TEXT NOT NULL,
    "polarity" TEXT NOT NULL,
    "scoreDelta" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SportEventTaxonomy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SportSpatialRules" (
    "id" TEXT NOT NULL,
    "sport" "SportKind" NOT NULL,
    "pluginCode" TEXT,
    "rules" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SportSpatialRules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegionalHealthSnapshot" (
    "id" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegionalHealthSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceFleetHealth" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "model" TEXT NOT NULL,
    "totalDevices" INTEGER NOT NULL DEFAULT 0,
    "activeDevices" INTEGER NOT NULL DEFAULT 0,
    "staleDevices" INTEGER NOT NULL DEFAULT 0,
    "meanScore" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceFleetHealth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIConsensusHealth" (
    "id" TEXT NOT NULL,
    "matchId" TEXT,
    "agreementRate" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "divergenceCount" INTEGER NOT NULL DEFAULT 0,
    "windowMs" INTEGER NOT NULL DEFAULT 300000,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIConsensusHealth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FederatedAggregationHealth" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "participants" INTEGER NOT NULL DEFAULT 0,
    "rejectedCount" INTEGER NOT NULL DEFAULT 0,
    "acceptedCount" INTEGER NOT NULL DEFAULT 0,
    "meanNorm" DOUBLE PRECISION,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FederatedAggregationHealth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SimulationQueueHealth" (
    "id" TEXT NOT NULL,
    "pending" INTEGER NOT NULL DEFAULT 0,
    "running" INTEGER NOT NULL DEFAULT 0,
    "completed1h" INTEGER NOT NULL DEFAULT 0,
    "failed1h" INTEGER NOT NULL DEFAULT 0,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SimulationQueueHealth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationTwin" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationTwin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubTwin" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "sportingState" JSONB,
    "financialState" JSONB,
    "staffingState" JSONB,
    "hardwareState" JSONB,
    "playerState" JSONB,
    "trainingState" JSONB,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClubTwin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AcademyTwin" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "academyName" TEXT NOT NULL,
    "ageGroups" JSONB,
    "playerCount" INTEGER NOT NULL DEFAULT 0,
    "staffCount" INTEGER NOT NULL DEFAULT 0,
    "performanceScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "financialFlow" JSONB,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AcademyTwin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepartmentTwin" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "headStaffId" TEXT,
    "payload" JSONB NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DepartmentTwin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffTwin" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "staffUserId" TEXT,
    "staffKind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffTwin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutiveAgent" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "role" "ExecAgentRole" NOT NULL,
    "label" TEXT NOT NULL,
    "config" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExecutiveAgent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutiveDecision" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "agentId" TEXT,
    "kind" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "tacticalImpact" "AIDecisionImpact" NOT NULL DEFAULT 'LOW',
    "approvalRequestId" TEXT,
    "payloadHash" TEXT,
    "modelVersion" TEXT NOT NULL DEFAULT 'm1',
    "status" "AlertStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ackedAt" TIMESTAMP(3),
    "ackedBy" TEXT,

    CONSTRAINT "ExecutiveDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DecisionCouncil" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "status" "CouncilStatus" NOT NULL DEFAULT 'OPEN',
    "agentIds" JSONB NOT NULL,
    "votesCount" INTEGER NOT NULL DEFAULT 0,
    "approvalsCount" INTEGER NOT NULL DEFAULT 0,
    "rejectionsCount" INTEGER NOT NULL DEFAULT 0,
    "abstentionsCount" INTEGER NOT NULL DEFAULT 0,
    "consensusScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "conflictCount" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "DecisionCouncil_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CouncilVote" (
    "id" TEXT NOT NULL,
    "councilId" TEXT NOT NULL,
    "voterId" TEXT NOT NULL,
    "voterKind" TEXT NOT NULL,
    "vote" "CouncilVoteType" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "rationale" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CouncilVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayerTarget" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "playerId" TEXT,
    "externalRef" TEXT,
    "playerName" TEXT NOT NULL,
    "position" TEXT,
    "age" INTEGER,
    "currentClub" TEXT,
    "marketValue" DOUBLE PRECISION,
    "contractUntil" TIMESTAMP(3),
    "status" "RecruitmentStatus" NOT NULL DEFAULT 'LEAD',
    "priority" INTEGER NOT NULL DEFAULT 50,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlayerTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecruitmentScoutReport" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "playerTargetId" TEXT,
    "playerId" TEXT,
    "scoutUserId" TEXT,
    "reportKind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecruitmentScoutReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecruitmentScore" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "playerTargetId" TEXT,
    "playerId" TEXT,
    "score" DOUBLE PRECISION NOT NULL,
    "components" JSONB NOT NULL,
    "modelVersion" TEXT NOT NULL DEFAULT 'm1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecruitmentScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransferProbability" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "playerTargetId" TEXT,
    "playerId" TEXT,
    "probability" DOUBLE PRECISION NOT NULL,
    "horizonDays" INTEGER NOT NULL DEFAULT 90,
    "components" JSONB NOT NULL,
    "modelVersion" TEXT NOT NULL DEFAULT 'm1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransferProbability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TalentProjection" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "playerTargetId" TEXT,
    "playerId" TEXT,
    "horizonYears" INTEGER NOT NULL DEFAULT 3,
    "projectedOVR" INTEGER NOT NULL,
    "components" JSONB NOT NULL,
    "modelVersion" TEXT NOT NULL DEFAULT 'm1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TalentProjection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingOptimizationPlan" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "teamId" TEXT,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "TrainingPlanStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrainingOptimizationPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryPlan" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "fromDate" TIMESTAMP(3) NOT NULL,
    "toDate" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "TrainingPlanStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecoveryPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoadDistributionPlan" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "teamId" TEXT,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "TrainingPlanStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoadDistributionPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MicrocyclePlan" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "teamId" TEXT,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "dailyPayload" JSONB NOT NULL,
    "status" "TrainingPlanStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MicrocyclePlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeasonPlan" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "season" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "TrainingPlanStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeasonPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayerAssetValue" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "valueCents" INTEGER NOT NULL DEFAULT 0,
    "components" JSONB NOT NULL,
    "modelVersion" TEXT NOT NULL DEFAULT 'm1',
    "validUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlayerAssetValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractRisk" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "riskScore" DOUBLE PRECISION NOT NULL,
    "expiryDate" TIMESTAMP(3),
    "components" JSONB NOT NULL,
    "modelVersion" TEXT NOT NULL DEFAULT 'm1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContractRisk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SponsorImpact" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "sponsorName" TEXT,
    "channelKind" TEXT NOT NULL,
    "valueCents" INTEGER NOT NULL DEFAULT 0,
    "components" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SponsorImpact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommercialScore" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "refId" TEXT,
    "score" DOUBLE PRECISION NOT NULL,
    "components" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommercialScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AcademyROI" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "academyName" TEXT NOT NULL,
    "season" TEXT NOT NULL,
    "investmentCents" INTEGER NOT NULL DEFAULT 0,
    "valueCreatedCents" INTEGER NOT NULL DEFAULT 0,
    "roi" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "components" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AcademyROI_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TalentGraph" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "modelVersion" TEXT NOT NULL DEFAULT 'm1',
    "monotonicMs" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TalentGraph_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScoutNetwork" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "scoutUserId" TEXT NOT NULL,
    "regionCode" TEXT,
    "languages" JSONB,
    "specialities" JSONB,
    "ratings" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScoutNetwork_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayerSimilarityGraph" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "sourcePlayerId" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "modelVersion" TEXT NOT NULL DEFAULT 'm1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlayerSimilarityGraph_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CareerProjectionGraph" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "modelVersion" TEXT NOT NULL DEFAULT 'm1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CareerProjectionGraph_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketplaceItem" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "kind" "MarketplaceItemKind" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "payload" JSONB NOT NULL,
    "status" "MarketplaceItemStatus" NOT NULL DEFAULT 'DRAFT',
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketplaceItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeDocument" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "kind" "KnowledgeNodeKind" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "tags" JSONB,
    "embedding" JSONB,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "KnowledgeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeGraph" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeGraph_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TacticalPatternLibrary" (
    "id" TEXT NOT NULL,
    "sport" "SportKind" NOT NULL,
    "pluginCode" TEXT,
    "patternName" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "tags" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TacticalPatternLibrary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MedicalKnowledgeNode" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "tags" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MedicalKnowledgeNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlobalKnowledgeNode" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "nodeKind" "KnowledgeNodeType" NOT NULL,
    "externalRef" TEXT,
    "label" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GlobalKnowledgeNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlobalKnowledgeEdge" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "fromNodeId" TEXT NOT NULL,
    "toNodeId" TEXT NOT NULL,
    "edgeKind" "KnowledgeEdgeType" NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "metadata" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GlobalKnowledgeEdge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UniversalAthleteId" (
    "id" TEXT NOT NULL,
    "idHash" TEXT NOT NULL,
    "sport" "SportKind" NOT NULL DEFAULT 'FOOTBALL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UniversalAthleteId_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AthleteIdentityLink" (
    "id" TEXT NOT NULL,
    "athleteId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "linkedById" TEXT,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AthleteIdentityLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AthletePerformanceHistory" (
    "id" TEXT NOT NULL,
    "athleteId" TEXT NOT NULL,
    "season" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AthletePerformanceHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AthleteMedicalHistory" (
    "id" TEXT NOT NULL,
    "athleteId" TEXT NOT NULL,
    "recordKind" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AthleteMedicalHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AthleteTransferHistory" (
    "id" TEXT NOT NULL,
    "athleteId" TEXT NOT NULL,
    "fromClubRef" TEXT,
    "toClubRef" TEXT,
    "feeCents" BIGINT,
    "currency" TEXT DEFAULT 'EUR',
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AthleteTransferHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TalentEvolutionGraph" (
    "id" TEXT NOT NULL,
    "athleteId" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "modelVersion" TEXT NOT NULL DEFAULT 'n1',
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TalentEvolutionGraph_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorldwideScoutingNode" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "label" TEXT NOT NULL,
    "regionCode" TEXT,
    "countryCodes" JSONB,
    "specialities" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorldwideScoutingNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TalentDiscoveryEvent" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "scoutingNodeId" TEXT,
    "athleteIdHash" TEXT,
    "externalRef" TEXT,
    "prospectName" TEXT NOT NULL,
    "position" TEXT,
    "age" INTEGER,
    "region" TEXT,
    "status" "DiscoveryStatus" NOT NULL DEFAULT 'PROSPECT',
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TalentDiscoveryEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlobalRecommendationRanking" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "discoveryId" TEXT,
    "athleteIdHash" TEXT,
    "position" TEXT,
    "score" DOUBLE PRECISION NOT NULL,
    "components" JSONB NOT NULL,
    "modelVersion" TEXT NOT NULL DEFAULT 'n1',
    "signatureB64" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GlobalRecommendationRanking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConfidenceScore" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "sourceKind" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "components" JSONB,
    "modelVersion" TEXT NOT NULL DEFAULT 'n1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConfidenceScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScoutingEvaluation" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "discoveryId" TEXT,
    "athleteIdHash" TEXT,
    "evaluatorId" TEXT,
    "payload" JSONB NOT NULL,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "modelVersion" TEXT NOT NULL DEFAULT 'n1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScoutingEvaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketTransferPrediction" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "athleteIdHash" TEXT,
    "fromClubRef" TEXT,
    "toClubRef" TEXT,
    "probability" DOUBLE PRECISION NOT NULL,
    "expectedFeeCents" BIGINT,
    "horizonDays" INTEGER NOT NULL DEFAULT 180,
    "components" JSONB NOT NULL,
    "modelVersion" TEXT NOT NULL DEFAULT 'n1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketTransferPrediction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractIntelligenceSnapshot" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "athleteIdHash" TEXT,
    "signal" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "modelVersion" TEXT NOT NULL DEFAULT 'n1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContractIntelligenceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AcademyDevelopmentForecast" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "academyName" TEXT NOT NULL,
    "horizonYears" INTEGER NOT NULL DEFAULT 5,
    "projectedValueCents" BIGINT NOT NULL DEFAULT 0,
    "components" JSONB NOT NULL,
    "modelVersion" TEXT NOT NULL DEFAULT 'n1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AcademyDevelopmentForecast_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReasoningTrace" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "kind" "ReasoningKind" NOT NULL,
    "question" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "conclusion" JSONB NOT NULL,
    "modelVersion" TEXT NOT NULL DEFAULT 'n1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReasoningTrace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExplainableDecision" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "traceId" TEXT,
    "topic" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "sources" JSONB NOT NULL,
    "payloadHash" TEXT,
    "signatureB64" TEXT,
    "modelVersion" TEXT NOT NULL DEFAULT 'n1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExplainableDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeterministicReasoningRule" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" "ReasoningKind" NOT NULL,
    "rule" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "publishedBy" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeterministicReasoningRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CryptographicGraphAnchor" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "anchorKind" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "cardinality" INTEGER NOT NULL DEFAULT 0,
    "asOf" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CryptographicGraphAnchor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecommendationSignature" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "recommendationId" TEXT NOT NULL,
    "recommendationKind" TEXT NOT NULL,
    "signatureB64" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "signerVersion" TEXT NOT NULL DEFAULT 'n1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecommendationSignature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrustScore" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "sourceKind" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "observations" INTEGER NOT NULL DEFAULT 0,
    "components" JSONB,
    "modelVersion" TEXT NOT NULL DEFAULT 'n1',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrustScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "refreshHash" TEXT NOT NULL,
    "deviceLabel" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "status" "AuthSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "mfaSatisfied" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "parentSessionId" TEXT,

    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MFASetting" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "method" "MfaMethod" NOT NULL DEFAULT 'NONE',
    "secretEncrypted" TEXT,
    "backupCodesHash" JSONB,
    "enabledAt" TIMESTAMP(3),
    "lastVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MFASetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MFAChallenge" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "challengeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MFAChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayerGuardianLink" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "guardianUserId" TEXT NOT NULL,
    "relationship" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlayerGuardianLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingAttendanceRecord" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "trainingSessionId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "mark" "AttendanceMark" NOT NULL DEFAULT 'PRESENT',
    "notes" TEXT,
    "recordedById" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrainingAttendanceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchAttendanceRecord" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "mark" "AttendanceMark" NOT NULL DEFAULT 'PRESENT',
    "minutesOnPitch" INTEGER,
    "notes" TEXT,
    "recordedById" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MatchAttendanceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationsPayment" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "payerUserId" TEXT,
    "payerPlayerId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "state" "OperationsPaymentState" NOT NULL DEFAULT 'PENDING',
    "category" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "invoiceRef" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperationsPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationsInvoiceLine" (
    "id" TEXT NOT NULL,
    "invoiceDraftId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitCents" INTEGER NOT NULL DEFAULT 0,
    "totalCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperationsInvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubCalendarEntry" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "teamId" TEXT,
    "kind" "ClubEventKind" NOT NULL DEFAULT 'OTHER',
    "title" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "location" TEXT,
    "payload" JSONB,
    "externalRef" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubCalendarEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayerOnboardingStep" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "completedAt" TIMESTAMP(3),
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlayerOnboardingStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayerEvaluationRecord" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "evaluatorId" TEXT,
    "kind" TEXT NOT NULL,
    "score" DOUBLE PRECISION,
    "payload" JSONB NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlayerEvaluationRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayerContractRecord" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "state" "PlayerContractState" NOT NULL DEFAULT 'DRAFT',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "weeklyWageCents" INTEGER NOT NULL DEFAULT 0,
    "signingBonusCents" INTEGER NOT NULL DEFAULT 0,
    "releaseClauseCents" INTEGER,
    "payload" JSONB,
    "signedAt" TIMESTAMP(3),
    "terminatedAt" TIMESTAMP(3),
    "payloadHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlayerContractRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceInventoryEntry" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "deviceId" TEXT,
    "serial" TEXT NOT NULL,
    "state" "DeviceInventoryState" NOT NULL DEFAULT 'STOCK',
    "location" TEXT,
    "shippedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "rmaReason" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceInventoryEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceDiagnosticReport" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "reportKind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceDiagnosticReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserNotificationChannel" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "preferences" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserNotificationChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpsReportTemplate" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "publishedBy" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpsReportTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpsReportRun" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "parameters" JSONB NOT NULL,
    "output" JSONB NOT NULL,
    "outputHash" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "OpsReportRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataRetentionPolicy" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "entityType" TEXT NOT NULL,
    "retentionDays" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "publishedBy" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DataRetentionPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GdprDataRequest" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "requestingUserId" TEXT NOT NULL,
    "subjectUserId" TEXT,
    "subjectPlayerId" TEXT,
    "kind" "GdprRequestKind" NOT NULL,
    "state" "GdprRequestState" NOT NULL DEFAULT 'PENDING',
    "scope" JSONB,
    "payloadHash" TEXT,
    "completedAt" TIMESTAMP(3),
    "resultRef" TEXT,
    "rejectedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GdprDataRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserConsentRecord" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "userId" TEXT,
    "playerId" TEXT,
    "scope" "ConsentScope" NOT NULL,
    "granted" BOOLEAN NOT NULL DEFAULT true,
    "payload" JSONB,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "UserConsentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionHealthCheck" (
    "id" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "state" "HealthCheckState" NOT NULL DEFAULT 'OK',
    "latencyMs" INTEGER,
    "payload" JSONB,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductionHealthCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionAlertRule" (
    "id" TEXT NOT NULL,
    "clubId" TEXT,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "expression" TEXT NOT NULL,
    "threshold" DOUBLE PRECISION,
    "channelTargets" JSONB,
    "state" "AlertRuleState" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductionAlertRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackupRecord" (
    "id" TEXT NOT NULL,
    "kind" "BackupKind" NOT NULL DEFAULT 'SCHEDULED',
    "ref" TEXT,
    "sizeBytes" BIGINT,
    "sha256" TEXT,
    "notes" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "ok" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "BackupRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserNotification" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "UserNotificationKind" NOT NULL DEFAULT 'SYSTEM',
    "title" TEXT NOT NULL,
    "body" TEXT,
    "payload" JSONB,
    "readAt" TIMESTAMP(3),
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tournament" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "CompetitionType" NOT NULL,
    "season" TEXT NOT NULL DEFAULT '2024-25',
    "teams" INTEGER NOT NULL DEFAULT 16,
    "position" INTEGER,
    "points" INTEGER,
    "played" INTEGER NOT NULL DEFAULT 0,
    "won" INTEGER NOT NULL DEFAULT 0,
    "drawn" INTEGER NOT NULL DEFAULT 0,
    "lost" INTEGER NOT NULL DEFAULT 0,
    "goalsFor" INTEGER NOT NULL DEFAULT 0,
    "goalsAgainst" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tournament_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingSession" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "duration" INTEGER NOT NULL,
    "drills" "DrillType"[],
    "attackForm" INTEGER NOT NULL DEFAULT 12,
    "defenseForm" INTEGER NOT NULL DEFAULT 14,
    "possession" INTEGER NOT NULL DEFAULT 11,
    "conditionForm" INTEGER NOT NULL DEFAULT 13,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrainingSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayerTrainingStat" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "attended" BOOLEAN NOT NULL DEFAULT true,
    "rating" DOUBLE PRECISION,
    "notes" TEXT,

    CONSTRAINT "PlayerTrainingStat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GpsDevice" (
    "id" TEXT NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "firmware" TEXT NOT NULL DEFAULT 'v1.2',
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "batteryLevel" INTEGER NOT NULL DEFAULT 100,
    "signalQuality" INTEGER NOT NULL DEFAULT 100,
    "clubId" TEXT NOT NULL,
    "playerId" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GpsDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScoutReport" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "targetName" TEXT NOT NULL,
    "targetClub" TEXT NOT NULL,
    "position" "PlayerPosition" NOT NULL,
    "age" INTEGER NOT NULL,
    "nationality" TEXT NOT NULL,
    "flag" TEXT NOT NULL,
    "marketValue" DOUBLE PRECISION NOT NULL,
    "rating" DOUBLE PRECISION NOT NULL,
    "recommendation" "ScoutRecommendation" NOT NULL,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScoutReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Financial" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "type" "TransactionType" NOT NULL,
    "category" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "description" TEXT,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Financial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiInsight" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "model" TEXT NOT NULL DEFAULT 'claude-sonnet-4-20250514',
    "tokens" INTEGER,
    "playerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiInsight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhiteLabelConfig" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "productName" TEXT,
    "tagline" TEXT,
    "logoUrl" TEXT,
    "logoDarkUrl" TEXT,
    "faviconUrl" TEXT,
    "ogImageUrl" TEXT,
    "primaryColor" TEXT NOT NULL DEFAULT '#0f172a',
    "secondaryColor" TEXT NOT NULL DEFAULT '#64748b',
    "accentColor" TEXT NOT NULL DEFAULT '#22c55e',
    "backgroundColor" TEXT NOT NULL DEFAULT '#ffffff',
    "surfaceColor" TEXT NOT NULL DEFAULT '#f8fafc',
    "textColor" TEXT NOT NULL DEFAULT '#0f172a',
    "mutedTextColor" TEXT NOT NULL DEFAULT '#64748b',
    "borderColor" TEXT NOT NULL DEFAULT '#e2e8f0',
    "errorColor" TEXT NOT NULL DEFAULT '#ef4444',
    "successColor" TEXT NOT NULL DEFAULT '#22c55e',
    "warningColor" TEXT NOT NULL DEFAULT '#f59e0b',
    "fontFamily" TEXT NOT NULL DEFAULT 'Inter, system-ui, -apple-system, sans-serif',
    "fontHeadingUrl" TEXT,
    "fontBodyUrl" TEXT,
    "supportEmail" TEXT,
    "supportUrl" TEXT,
    "termsUrl" TEXT,
    "privacyUrl" TEXT,
    "marketingUrl" TEXT,
    "emailFromName" TEXT,
    "emailFromEmail" TEXT,
    "emailReplyTo" TEXT,
    "emailHeaderHtml" TEXT,
    "emailFooterHtml" TEXT,
    "hidePoweredBy" BOOLEAN NOT NULL DEFAULT false,
    "hideInvestor" BOOLEAN NOT NULL DEFAULT true,
    "hideMarketplace" BOOLEAN NOT NULL DEFAULT false,
    "customCss" TEXT,
    "customHeadHtml" TEXT,
    "defaultLocale" TEXT NOT NULL DEFAULT 'en',
    "metadata" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "WhiteLabelConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhiteLabelDomain" (
    "id" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "status" "WhiteLabelDomainStatus" NOT NULL DEFAULT 'PENDING',
    "verifyToken" TEXT NOT NULL,
    "verifyHost" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "sslIssuedAt" TIMESTAMP(3),
    "sslExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhiteLabelDomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhiteLabelAudit" (
    "id" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "userId" TEXT,
    "action" "WhiteLabelAuditAction" NOT NULL,
    "changes" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhiteLabelAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformAdmin" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "PlatformRole" NOT NULL,
    "ipAllowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mfaEnforced" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "invitedBy" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformAdmin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhiteLabelAsset" (
    "id" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "type" "AssetType" NOT NULL,
    "storage" "AssetStorage" NOT NULL DEFAULT 'LOCAL',
    "bucket" TEXT,
    "storageKey" TEXT,
    "url" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "checksum" TEXT NOT NULL,
    "uploadedBy" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhiteLabelAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ColorPaletteTemplate" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "category" TEXT NOT NULL DEFAULT 'custom',
    "tokens" JSONB NOT NULL,
    "preview" TEXT,
    "createdBy" TEXT,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ColorPaletteTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationLimits" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "maxUsers" INTEGER,
    "maxPlayers" INTEGER,
    "maxGpsDevices" INTEGER,
    "maxStorageMb" INTEGER,
    "maxApiCallsPerDay" INTEGER,
    "maxAiInsightsPerMonth" INTEGER,
    "maxCustomDomains" INTEGER,
    "maxPdfReportsPerMonth" INTEGER,
    "maxImpersonationsPerDay" INTEGER,
    "featuresEnabled" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "featuresDisabled" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "setBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationLimits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionOverride" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "plan" "SubscriptionPlan" NOT NULL,
    "status" "SubscriptionStatus" NOT NULL,
    "reason" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "bypassStripe" BOOLEAN NOT NULL DEFAULT false,
    "appliedBy" TEXT NOT NULL,
    "revokedBy" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeatureFlag" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "defaultEnabled" BOOLEAN NOT NULL DEFAULT false,
    "enabledForPlans" "SubscriptionPlan"[] DEFAULT ARRAY[]::"SubscriptionPlan"[],
    "isInternal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeatureFlag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImpersonationSession" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "targetClubId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "endedReason" TEXT,
    "status" "ImpersonationStatus" NOT NULL DEFAULT 'ACTIVE',
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImpersonationSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformAuditLog" (
    "id" TEXT NOT NULL,
    "adminId" TEXT,
    "userId" TEXT,
    "clubId" TEXT,
    "action" TEXT NOT NULL,
    "category" "PlatformAuditCategory" NOT NULL,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "metadata" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "result" "PlatformAuditResult" NOT NULL DEFAULT 'SUCCESS',
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Territory" (
    "id" TEXT NOT NULL,
    "type" "TerritoryType" NOT NULL,
    "code" TEXT,
    "name" TEXT NOT NULL,
    "fullPath" TEXT NOT NULL,
    "parentId" TEXT,
    "population" INTEGER,
    "currency" TEXT,
    "timezone" TEXT,
    "metadata" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Territory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FranchiseUnit" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "level" "FranchiseLevel" NOT NULL,
    "status" "FranchiseStatus" NOT NULL DEFAULT 'PENDING',
    "ownershipModel" "OwnershipModel" NOT NULL DEFAULT 'SINGLE_OWNER',
    "parentUnitId" TEXT,
    "territoryId" TEXT,
    "legalName" TEXT,
    "taxId" TEXT,
    "registrationNo" TEXT,
    "address" TEXT,
    "countryCode" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "foundedAt" TIMESTAMP(3),
    "launchedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FranchiseUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FranchiseOwner" (
    "id" TEXT NOT NULL,
    "type" "OwnerType" NOT NULL,
    "displayName" TEXT NOT NULL,
    "userId" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "legalName" TEXT,
    "taxId" TEXT,
    "legalAddress" TEXT,
    "countryCode" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FranchiseOwner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FranchiseOwnership" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "equityPercent" DOUBLE PRECISION NOT NULL,
    "controlPercent" DOUBLE PRECISION,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "acquiredVia" TEXT,
    "acquisitionRequestId" TEXT,
    "transferInId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FranchiseOwnership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FranchiseOwnershipTransfer" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "fromOwnerId" TEXT NOT NULL,
    "toOwnerId" TEXT NOT NULL,
    "equityPercent" DOUBLE PRECISION NOT NULL,
    "controlPercent" DOUBLE PRECISION,
    "amount" DOUBLE PRECISION,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "reason" "TransferReason" NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'PENDING',
    "acquisitionRequestId" TEXT,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledReason" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FranchiseOwnershipTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TerritoryRight" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "territoryId" TEXT NOT NULL,
    "type" "TerritoryRightType" NOT NULL DEFAULT 'NON_EXCLUSIVE',
    "level" "FranchiseLevel",
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TerritoryRight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpansionRequest" (
    "id" TEXT NOT NULL,
    "requestingUnitId" TEXT NOT NULL,
    "targetTerritoryId" TEXT NOT NULL,
    "targetLevel" "FranchiseLevel" NOT NULL,
    "proposedName" TEXT,
    "proposedCode" TEXT,
    "businessPlan" JSONB,
    "financialProjection" JSONB,
    "status" "ExpansionRequestStatus" NOT NULL DEFAULT 'PENDING',
    "submittedBy" TEXT NOT NULL,
    "reviewedBy" TEXT,
    "decisionAt" TIMESTAMP(3),
    "decisionNotes" TEXT,
    "createdUnitId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExpansionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FranchiseAcquisitionRequest" (
    "id" TEXT NOT NULL,
    "targetUnitId" TEXT NOT NULL,
    "acquirerOwnerId" TEXT,
    "acquirerName" TEXT,
    "acquirerEmail" TEXT,
    "proposedEquity" DOUBLE PRECISION NOT NULL,
    "proposedAmount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "status" "AcquisitionStatus" NOT NULL DEFAULT 'DRAFT',
    "dueDiligence" JSONB,
    "decisionAt" TIMESTAMP(3),
    "decisionBy" TEXT,
    "decisionNotes" TEXT,
    "executedAt" TIMESTAMP(3),
    "transferId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "submittedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FranchiseAcquisitionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevenueSplitRule" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" "RevenueCategory" NOT NULL DEFAULT 'ALL',
    "trigger" "RevenueTrigger" NOT NULL DEFAULT 'PAYMENT_RECEIVED',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RevenueSplitRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevenueSplitRecipient" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "type" "RevenueRecipientType" NOT NULL,
    "recipientUnitId" TEXT,
    "recipientOwnerId" TEXT,
    "recipientLabel" TEXT,
    "percent" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "RevenueSplitRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevenueDistribution" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "ruleId" TEXT,
    "clubId" TEXT,
    "category" "RevenueCategory" NOT NULL,
    "sourceAmount" DOUBLE PRECISION NOT NULL,
    "sourceCurrency" TEXT NOT NULL DEFAULT 'EUR',
    "sourceFinancialId" TEXT,
    "sourceRef" TEXT,
    "status" "DistributionStatus" NOT NULL DEFAULT 'COMPUTED',
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "executedAt" TIMESTAMP(3),
    "reversedAt" TIMESTAMP(3),
    "reversalReason" TEXT,
    "notes" TEXT,

    CONSTRAINT "RevenueDistribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevenueDistributionAllocation" (
    "id" TEXT NOT NULL,
    "distributionId" TEXT NOT NULL,
    "recipientType" "RevenueRecipientType" NOT NULL,
    "recipientUnitId" TEXT,
    "recipientOwnerId" TEXT,
    "recipientLabel" TEXT,
    "percent" DOUBLE PRECISION NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "status" "AllocationStatus" NOT NULL DEFAULT 'PENDING',
    "paidAt" TIMESTAMP(3),
    "paymentMethod" TEXT,
    "paymentRef" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevenueDistributionAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FranchiseContract" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "type" "ContractType" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "ContractStatus" NOT NULL DEFAULT 'DRAFT',
    "documentUrl" TEXT,
    "documentChecksum" TEXT,
    "effectiveFrom" TIMESTAMP(3),
    "effectiveTo" TIMESTAMP(3),
    "autoRenew" BOOLEAN NOT NULL DEFAULT false,
    "renewalNoticeMonths" INTEGER NOT NULL DEFAULT 6,
    "governingLaw" TEXT,
    "jurisdiction" TEXT,
    "signedAt" TIMESTAMP(3),
    "signedByName" TEXT,
    "signedByTitle" TEXT,
    "terms" JSONB,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FranchiseContract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FranchiseContractRenewal" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "renewedToContractId" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "effectiveFrom" TIMESTAMP(3),
    "effectiveTo" TIMESTAMP(3),
    "status" "RenewalStatus" NOT NULL DEFAULT 'REQUESTED',
    "termsDelta" JSONB,
    "notes" TEXT,
    "decisionBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FranchiseContractRenewal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FranchiseContractTermination" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "reason" "TerminationReason" NOT NULL,
    "noticeDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveDate" TIMESTAMP(3),
    "status" "TerminationStatus" NOT NULL DEFAULT 'REQUESTED',
    "severance" DOUBLE PRECISION,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "initiatedBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FranchiseContractTermination_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FranchiseViolation" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "contractId" TEXT,
    "clauseRef" TEXT,
    "severity" "ViolationSeverity" NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "ViolationStatus" NOT NULL DEFAULT 'OPEN',
    "reportedBy" TEXT,
    "assignedTo" TEXT,
    "dueByAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "evidence" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FranchiseViolation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceCheck" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "category" "ComplianceCategory" NOT NULL,
    "period" TEXT NOT NULL,
    "periodStartAt" TIMESTAMP(3) NOT NULL,
    "periodEndAt" TIMESTAMP(3) NOT NULL,
    "status" "ComplianceStatus" NOT NULL DEFAULT 'NOT_ASSESSED',
    "score" DOUBLE PRECISION,
    "findings" JSONB,
    "remediation" TEXT,
    "dueByAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "completedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComplianceCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FranchisePerformanceSnapshot" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "periodStartAt" TIMESTAMP(3) NOT NULL,
    "periodEndAt" TIMESTAMP(3) NOT NULL,
    "revenueTotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "revenuePriorPeriod" DOUBLE PRECISION,
    "revenueGrowthPct" DOUBLE PRECISION,
    "expensesTotal" DOUBLE PRECISION DEFAULT 0,
    "netMargin" DOUBLE PRECISION,
    "clubsActive" INTEGER NOT NULL DEFAULT 0,
    "clubsTotal" INTEGER NOT NULL DEFAULT 0,
    "playersTotal" INTEGER NOT NULL DEFAULT 0,
    "usersTotal" INTEGER NOT NULL DEFAULT 0,
    "complianceScore" DOUBLE PRECISION,
    "licensingHealth" DOUBLE PRECISION,
    "violationsOpen" INTEGER NOT NULL DEFAULT 0,
    "contractsActive" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generatedBy" TEXT,

    CONSTRAINT "FranchisePerformanceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FranchiseAudit" (
    "id" TEXT NOT NULL,
    "unitId" TEXT,
    "userId" TEXT,
    "ownerId" TEXT,
    "action" TEXT NOT NULL,
    "category" "FranchiseAuditCategory" NOT NULL,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "metadata" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "result" "FranchiseAuditResult" NOT NULL DEFAULT 'SUCCESS',
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FranchiseAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvestorProfile" (
    "id" TEXT NOT NULL,
    "type" "InvestorType" NOT NULL,
    "entityType" "InvestorEntityType" NOT NULL,
    "displayName" TEXT NOT NULL,
    "legalName" TEXT,
    "userId" TEXT,
    "linkedFranchiseOwnerId" TEXT,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "countryCode" TEXT,
    "taxId" TEXT,
    "legalAddress" TEXT,
    "accredited" BOOLEAN NOT NULL DEFAULT false,
    "kycStatus" "KycStatus" NOT NULL DEFAULT 'PENDING',
    "kycVerifiedAt" TIMESTAMP(3),
    "kycExpiresAt" TIMESTAMP(3),
    "aumUsd" DOUBLE PRECISION,
    "targetSectors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "targetGeographies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "metadata" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvestorProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvestmentEntity" (
    "id" TEXT NOT NULL,
    "type" "InvestmentEntityType" NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "description" TEXT,
    "franchiseUnitId" TEXT,
    "clubId" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "currentValuation" DOUBLE PRECISION,
    "lastValuationAt" TIMESTAMP(3),
    "totalSharesIssued" INTEGER NOT NULL DEFAULT 0,
    "fullyDilutedShares" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvestmentEntity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShareClass" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "category" "ShareClassCategory" NOT NULL,
    "seniority" INTEGER NOT NULL DEFAULT 0,
    "liquidationPreference" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "participating" BOOLEAN NOT NULL DEFAULT false,
    "participationCap" DOUBLE PRECISION,
    "votingMultiple" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "dividendRate" DOUBLE PRECISION,
    "cumulativeDividends" BOOLEAN NOT NULL DEFAULT false,
    "convertibleToCode" TEXT,
    "antiDilutionType" "AntiDilutionType" NOT NULL DEFAULT 'NONE',
    "totalAuthorized" INTEGER NOT NULL DEFAULT 0,
    "totalIssued" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShareClass_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvestmentRound" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "type" "InvestmentRoundType" NOT NULL,
    "name" TEXT NOT NULL,
    "status" "InvestmentRoundStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "targetRaise" DOUBLE PRECISION NOT NULL,
    "actualRaise" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "preMoneyValuation" DOUBLE PRECISION,
    "postMoneyValuation" DOUBLE PRECISION,
    "pricePerShare" DOUBLE PRECISION,
    "sharesAuthorized" INTEGER,
    "sharesIssued" INTEGER NOT NULL DEFAULT 0,
    "shareClassId" TEXT,
    "openedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "leadInvestorId" TEXT,
    "terms" JSONB,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvestmentRound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Investment" (
    "id" TEXT NOT NULL,
    "investorId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "roundId" TEXT,
    "instrumentType" "InstrumentType" NOT NULL,
    "status" "InvestmentStatus" NOT NULL DEFAULT 'COMMITTED',
    "committedAmount" DOUBLE PRECISION NOT NULL,
    "fundedAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "shareClassId" TEXT,
    "sharesIssued" INTEGER,
    "pricePerShare" DOUBLE PRECISION,
    "valuationCap" DOUBLE PRECISION,
    "discountPercent" DOUBLE PRECISION,
    "mostFavoredNation" BOOLEAN NOT NULL DEFAULT false,
    "interestRate" DOUBLE PRECISION,
    "maturityDate" TIMESTAMP(3),
    "revenueSharePercent" DOUBLE PRECISION,
    "revenueShareCap" DOUBLE PRECISION,
    "revenueShareUntil" TIMESTAMP(3),
    "revenueCategories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "originalInvestmentId" TEXT,
    "convertedToInvestmentId" TEXT,
    "linkedFranchiseUnitId" TEXT,
    "linkedClubId" TEXT,
    "commitDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fundedDate" TIMESTAMP(3),
    "convertedDate" TIMESTAMP(3),
    "exitDate" TIMESTAMP(3),
    "notes" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Investment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CapTableEntry" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "investorId" TEXT NOT NULL,
    "shareClassId" TEXT NOT NULL,
    "shares" INTEGER NOT NULL,
    "pricePerShare" DOUBLE PRECISION,
    "totalCost" DOUBLE PRECISION,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "acquisitionType" "CapTableAcquisitionType" NOT NULL,
    "originalInvestmentId" TEXT,
    "transferInId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CapTableEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShareTransfer" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "fromInvestorId" TEXT NOT NULL,
    "toInvestorId" TEXT NOT NULL,
    "shareClassId" TEXT NOT NULL,
    "shares" INTEGER NOT NULL,
    "pricePerShare" DOUBLE PRECISION,
    "totalAmount" DOUBLE PRECISION,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "reason" "ShareTransferReason" NOT NULL,
    "status" "ShareTransferStatus" NOT NULL DEFAULT 'PENDING',
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledReason" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShareTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvestorRight" (
    "id" TEXT NOT NULL,
    "investorId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "type" "InvestorRightType" NOT NULL,
    "terms" JSONB,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvestorRight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BoardSeat" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "investorId" TEXT,
    "holderName" TEXT NOT NULL,
    "holderEmail" TEXT,
    "holderUserId" TEXT,
    "role" "BoardSeatRole" NOT NULL,
    "votingPower" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "appointedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "departedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BoardSeat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvestmentAgreement" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "investmentId" TEXT,
    "roundId" TEXT,
    "investorId" TEXT,
    "type" "AgreementType" NOT NULL,
    "status" "AgreementStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "documentUrl" TEXT,
    "documentChecksum" TEXT,
    "effectiveFrom" TIMESTAMP(3),
    "effectiveTo" TIMESTAMP(3),
    "signedAt" TIMESTAMP(3),
    "signedByName" TEXT,
    "signedByTitle" TEXT,
    "terms" JSONB,
    "governingLaw" TEXT,
    "jurisdiction" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvestmentAgreement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExitEvent" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "type" "ExitEventType" NOT NULL,
    "status" "ExitStatus" NOT NULL DEFAULT 'PROPOSED',
    "eventDate" TIMESTAMP(3),
    "proceedsAmount" DOUBLE PRECISION,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "pricePerShare" DOUBLE PRECISION,
    "acquirerName" TEXT,
    "terms" JSONB,
    "notes" TEXT,
    "createdBy" TEXT,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExitEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExitDistribution" (
    "id" TEXT NOT NULL,
    "exitId" TEXT NOT NULL,
    "investorId" TEXT NOT NULL,
    "sharesPaidOut" INTEGER NOT NULL DEFAULT 0,
    "liquidationPrefAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "participationAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "commonAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "grossAmount" DOUBLE PRECISION NOT NULL,
    "netAmount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "status" "InvestorDistributionStatus" NOT NULL DEFAULT 'PENDING',
    "paidAt" TIMESTAMP(3),
    "paymentRef" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExitDistribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvestorDistribution" (
    "id" TEXT NOT NULL,
    "investorId" TEXT NOT NULL,
    "investmentId" TEXT,
    "type" "InvestorDistributionType" NOT NULL,
    "status" "InvestorDistributionStatus" NOT NULL DEFAULT 'PENDING',
    "period" TEXT,
    "periodStartAt" TIMESTAMP(3),
    "periodEndAt" TIMESTAMP(3),
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "sourceRef" TEXT,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),
    "paymentMethod" TEXT,
    "paymentRef" TEXT,
    "failureReason" TEXT,
    "notes" TEXT,

    CONSTRAINT "InvestorDistribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvestorAudit" (
    "id" TEXT NOT NULL,
    "investorId" TEXT,
    "entityId" TEXT,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "category" "InvestorAuditCategory" NOT NULL,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "metadata" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "result" "InvestorAuditResult" NOT NULL DEFAULT 'SUCCESS',
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvestorAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIModel" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" "AIDomain" NOT NULL,
    "decisionType" "AIDecisionType" NOT NULL,
    "version" TEXT NOT NULL,
    "provider" "AIModelProvider" NOT NULL,
    "description" TEXT,
    "inputSchema" JSONB NOT NULL,
    "outputSchema" JSONB NOT NULL,
    "parameters" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "releasedAt" TIMESTAMP(3),
    "deprecatedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AIModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIDecision" (
    "id" TEXT NOT NULL,
    "domain" "AIDomain" NOT NULL,
    "decisionType" "AIDecisionType" NOT NULL,
    "modelId" TEXT NOT NULL,
    "modelSlug" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "clubId" TEXT,
    "franchiseUnitId" TEXT,
    "investorId" TEXT,
    "entityId" TEXT,
    "features" JSONB NOT NULL,
    "inputHash" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "urgency" "AIUrgency" NOT NULL DEFAULT 'MEDIUM',
    "recommendation" JSONB NOT NULL,
    "evidence" JSONB NOT NULL,
    "rationale" TEXT NOT NULL,
    "alternatives" JSONB,
    "warnings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "AIDecisionStatus" NOT NULL DEFAULT 'GENERATED',
    "visibility" "AIDecisionVisibility" NOT NULL DEFAULT 'CLUB',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNotes" TEXT,
    "outcome" "AIOutcome" NOT NULL DEFAULT 'PENDING',
    "outcomeAt" TIMESTAMP(3),
    "outcomeNotes" TEXT,
    "expiresAt" TIMESTAMP(3),
    "generatedByUserId" TEXT,
    "generatedByRole" TEXT,
    "llmTokensIn" INTEGER,
    "llmTokensOut" INTEGER,
    "llmDurationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AIDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIDecisionFeedback" (
    "id" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "type" "AIFeedbackType" NOT NULL,
    "rating" INTEGER,
    "notes" TEXT,
    "correctedAction" JSONB,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIDecisionFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIAudit" (
    "id" TEXT NOT NULL,
    "decisionId" TEXT,
    "modelId" TEXT,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "category" "AIAuditCategory" NOT NULL,
    "metadata" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "result" "AIAuditResult" NOT NULL DEFAULT 'SUCCESS',
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoAsset" (
    "id" TEXT NOT NULL,
    "source" "VideoSource" NOT NULL,
    "format" "VideoFormat" NOT NULL,
    "url" TEXT NOT NULL,
    "durationMs" INTEGER,
    "fps" DOUBLE PRECISION,
    "width" INTEGER,
    "height" INTEGER,
    "fileBytes" INTEGER,
    "checksum" TEXT,
    "clubId" TEXT,
    "matchId" TEXT,
    "trainingSessionId" TEXT,
    "title" TEXT,
    "description" TEXT,
    "metadata" JSONB,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VideoAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoIngestJob" (
    "id" TEXT NOT NULL,
    "videoAssetId" TEXT NOT NULL,
    "stage" "IngestStage" NOT NULL DEFAULT 'UPLOADED',
    "status" "IngestStatus" NOT NULL DEFAULT 'QUEUED',
    "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "inferenceProvider" TEXT,
    "externalJobId" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "error" TEXT,
    "notes" TEXT,
    "metadata" JSONB,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VideoIngestJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisionAnalysisRun" (
    "id" TEXT NOT NULL,
    "videoAssetId" TEXT NOT NULL,
    "matchId" TEXT,
    "trainingSessionId" TEXT,
    "clubId" TEXT,
    "modelProvider" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "status" "IngestStatus" NOT NULL DEFAULT 'QUEUED',
    "confidence" DOUBLE PRECISION,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "framesProcessed" INTEGER NOT NULL DEFAULT 0,
    "framesTotal" INTEGER,
    "warningsCount" INTEGER NOT NULL DEFAULT 0,
    "errorsCount" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VisionAnalysisRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayerTrack" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "playerId" TEXT,
    "jerseyNumber" INTEGER,
    "teamSide" "TeamSide" NOT NULL DEFAULT 'UNKNOWN',
    "startMs" INTEGER NOT NULL,
    "endMs" INTEGER NOT NULL,
    "avgX" DOUBLE PRECISION NOT NULL,
    "avgY" DOUBLE PRECISION NOT NULL,
    "topSpeedKmh" DOUBLE PRECISION,
    "avgSpeedKmh" DOUBLE PRECISION,
    "totalDistanceM" DOUBLE PRECISION,
    "sprintCount" INTEGER,
    "accelerations" INTEGER,
    "decelerations" INTEGER,
    "pathUrl" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlayerTrack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BallTrack" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "startMs" INTEGER NOT NULL,
    "endMs" INTEGER NOT NULL,
    "pathUrl" TEXT,
    "avgSpeedKmh" DOUBLE PRECISION,
    "topSpeedKmh" DOUBLE PRECISION,
    "inPlayMs" INTEGER,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BallTrack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchEvent" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "matchId" TEXT,
    "type" "VisionEventType" NOT NULL,
    "occurredAtMs" INTEGER NOT NULL,
    "frame" INTEGER,
    "durationMs" INTEGER,
    "primaryPlayerId" TEXT,
    "secondaryPlayerId" TEXT,
    "teamSide" "TeamSide" NOT NULL DEFAULT 'UNKNOWN',
    "pitchX" DOUBLE PRECISION,
    "pitchY" DOUBLE PRECISION,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "payload" JSONB,
    "overrideReason" TEXT,
    "overriddenBy" TEXT,
    "overriddenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MatchEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsResult" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "matchId" TEXT,
    "trainingSessionId" TEXT,
    "playerId" TEXT,
    "teamSide" "TeamSide" NOT NULL DEFAULT 'UNKNOWN',
    "kind" "AnalyticsKind" NOT NULL,
    "windowStartMs" INTEGER,
    "windowEndMs" INTEGER,
    "payload" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyticsResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FusedPlayerSample" (
    "id" TEXT NOT NULL,
    "matchId" TEXT,
    "trainingSessionId" TEXT,
    "playerId" TEXT NOT NULL,
    "windowStartMs" INTEGER NOT NULL,
    "windowEndMs" INTEGER NOT NULL,
    "visionDistanceM" DOUBLE PRECISION,
    "visionTopSpeedKmh" DOUBLE PRECISION,
    "visionAvgSpeedKmh" DOUBLE PRECISION,
    "visionSprintCount" INTEGER,
    "sensorDistanceM" DOUBLE PRECISION,
    "sensorTopSpeedKmh" DOUBLE PRECISION,
    "sensorPlayerLoad" DOUBLE PRECISION,
    "sensorHeartRateAvg" INTEGER,
    "sensorRiskScore" DOUBLE PRECISION,
    "fusedDistanceM" DOUBLE PRECISION,
    "fusedTopSpeedKmh" DOUBLE PRECISION,
    "fusedSprintCount" INTEGER,
    "verdict" "FusionVerdict" NOT NULL DEFAULT 'INSUFFICIENT_DATA',
    "agreementScore" DOUBLE PRECISION,
    "conflictReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FusedPlayerSample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Clip" (
    "id" TEXT NOT NULL,
    "videoAssetId" TEXT NOT NULL,
    "matchId" TEXT,
    "trainingSessionId" TEXT,
    "playerId" TEXT,
    "sourceEventId" TEXT,
    "purpose" "ClipPurpose" NOT NULL,
    "status" "ClipStatus" NOT NULL DEFAULT 'REQUESTED',
    "startMs" INTEGER NOT NULL,
    "endMs" INTEGER NOT NULL,
    "renderProvider" TEXT,
    "externalRenderId" TEXT,
    "url" TEXT,
    "thumbnailUrl" TEXT,
    "durationMs" INTEGER,
    "bytes" INTEGER,
    "title" TEXT,
    "description" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requestedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Clip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiveMatchStream" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "status" "LiveStreamStatus" NOT NULL DEFAULT 'IDLE',
    "streamUrl" TEXT,
    "ingestJobId" TEXT,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "lastEventAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LiveMatchStream_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiveEvent" (
    "id" TEXT NOT NULL,
    "streamId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "type" "VisionEventType" NOT NULL,
    "occurredAtMs" INTEGER NOT NULL,
    "primaryPlayerId" TEXT,
    "secondaryPlayerId" TEXT,
    "teamSide" "TeamSide" NOT NULL DEFAULT 'UNKNOWN',
    "pitchX" DOUBLE PRECISION,
    "pitchY" DOUBLE PRECISION,
    "payload" JSONB,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LiveEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScoutingReport" (
    "id" TEXT NOT NULL,
    "kind" "ScoutingKind" NOT NULL,
    "matchId" TEXT,
    "opponentName" TEXT,
    "targetPlayerId" TEXT,
    "targetClubId" TEXT,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "generatedFromAnalysisId" TEXT,
    "generatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScoutingReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisionAudit" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT,
    "videoAssetId" TEXT,
    "matchId" TEXT,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "category" "VisionAuditCategory" NOT NULL,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "metadata" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "result" "VisionAuditResult" NOT NULL DEFAULT 'SUCCESS',
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VisionAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutiveAssignment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "ExecutiveRole" NOT NULL,
    "voteWeight" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "assignedBy" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExecutiveAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutiveWorkflow" (
    "id" TEXT NOT NULL,
    "kind" "ExecutiveWorkflowKind" NOT NULL,
    "templateSlug" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "ExecutiveWorkflowStatus" NOT NULL DEFAULT 'DRAFT',
    "priority" "ExecutivePriority" NOT NULL DEFAULT 'NORMAL',
    "clubId" TEXT,
    "franchiseUnitId" TEXT,
    "investorId" TEXT,
    "entityId" TEXT,
    "sponsorOpportunityId" TEXT,
    "matchId" TEXT,
    "decisionIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requiredAttestations" "ExecutiveRole"[] DEFAULT ARRAY[]::"ExecutiveRole"[],
    "payload" JSONB NOT NULL,
    "outcome" JSONB,
    "initiatedBy" TEXT NOT NULL,
    "ownedBy" TEXT,
    "dueByAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExecutiveWorkflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowStep" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "engine" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "status" "ExecutiveStepStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "result" JSONB,
    "error" TEXT,
    "startedBy" TEXT,
    "completedBy" TEXT,
    "blockedReason" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowAttestation" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "attesterUserId" TEXT NOT NULL,
    "attesterAssignmentId" TEXT,
    "role" "ExecutiveRole" NOT NULL,
    "decision" "AttestationDecision" NOT NULL,
    "notes" TEXT,
    "signatureRef" TEXT,
    "attestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowAttestation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BoardResolution" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT,
    "title" TEXT NOT NULL,
    "resolutionText" TEXT NOT NULL,
    "status" "BoardResolutionStatus" NOT NULL DEFAULT 'DRAFT',
    "quorumRequired" INTEGER NOT NULL DEFAULT 3,
    "passingMajority" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "votesFor" INTEGER NOT NULL DEFAULT 0,
    "votesAgainst" INTEGER NOT NULL DEFAULT 0,
    "votesAbstain" INTEGER NOT NULL DEFAULT 0,
    "totalWeight" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "circulationOpenedAt" TIMESTAMP(3),
    "votingOpenedAt" TIMESTAMP(3),
    "votingClosesAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "effectiveAt" TIMESTAMP(3),
    "withdrawnAt" TIMESTAMP(3),
    "withdrawnReason" TEXT,
    "initiatedBy" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BoardResolution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BoardVote" (
    "id" TEXT NOT NULL,
    "resolutionId" TEXT NOT NULL,
    "voterUserId" TEXT NOT NULL,
    "assignmentId" TEXT,
    "role" "ExecutiveRole" NOT NULL,
    "decision" "BoardVoteDecision" NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "rationale" TEXT,
    "signatureRef" TEXT,
    "votedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BoardVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SponsorOpportunity" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tier" "SponsorTier" NOT NULL,
    "stage" "SponsorPipelineStage" NOT NULL DEFAULT 'PROSPECT',
    "clubId" TEXT,
    "franchiseUnitId" TEXT,
    "workflowId" TEXT,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "websiteUrl" TEXT,
    "industry" TEXT,
    "countryCode" TEXT,
    "proposedValue" DOUBLE PRECISION,
    "contractedValue" DOUBLE PRECISION,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "termMonths" INTEGER,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "agreementUrl" TEXT,
    "agreementChecksum" TEXT,
    "ownedBy" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SponsorOpportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SponsorPipelineEvent" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "fromStage" "SponsorPipelineStage" NOT NULL,
    "toStage" "SponsorPipelineStage" NOT NULL,
    "notes" TEXT,
    "changedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SponsorPipelineEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevenueForecast" (
    "id" TEXT NOT NULL,
    "scope" "ForecastScope" NOT NULL,
    "scopeId" TEXT,
    "periodKey" TEXT NOT NULL,
    "periodStartAt" TIMESTAMP(3) NOT NULL,
    "periodEndAt" TIMESTAMP(3) NOT NULL,
    "scenario" "ForecastScenario" NOT NULL DEFAULT 'BASE',
    "totalRevenue" DOUBLE PRECISION NOT NULL,
    "totalExpenses" DOUBLE PRECISION,
    "netCashFlow" DOUBLE PRECISION,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.6,
    "modelVersion" TEXT NOT NULL DEFAULT '1.0.0',
    "assumptions" JSONB NOT NULL,
    "breakdown" JSONB NOT NULL,
    "generatedBy" TEXT,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevenueForecast_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskAlert" (
    "id" TEXT NOT NULL,
    "category" "RiskCategory" NOT NULL,
    "severity" "RiskSeverity" NOT NULL,
    "status" "RiskAlertStatus" NOT NULL DEFAULT 'OPEN',
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "clubId" TEXT,
    "franchiseUnitId" TEXT,
    "investorId" TEXT,
    "entityId" TEXT,
    "sourceEngine" TEXT NOT NULL,
    "sourceRef" TEXT,
    "fingerprint" TEXT NOT NULL,
    "score" DOUBLE PRECISION,
    "acknowledgedBy" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "dueByAt" TIMESTAMP(3),
    "workflowId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RiskAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutiveAudit" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT,
    "resolutionId" TEXT,
    "alertId" TEXT,
    "forecastId" TEXT,
    "opportunityId" TEXT,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "category" "ExecutiveAuditCategory" NOT NULL,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "metadata" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "result" "ExecutiveAuditResult" NOT NULL DEFAULT 'SUCCESS',
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutiveAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Club_stripeCustomerId_key" ON "Club"("stripeCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "Club_stripeSubscriptionId_key" ON "Club"("stripeSubscriptionId");

-- CreateIndex
CREATE INDEX "Club_stripeCustomerId_idx" ON "Club"("stripeCustomerId");

-- CreateIndex
CREATE INDEX "Club_franchiseUnitId_idx" ON "Club"("franchiseUnitId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_clubId_idx" ON "User"("clubId");

-- CreateIndex
CREATE INDEX "User_email_idx" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_currentClubId_idx" ON "User"("currentClubId");

-- CreateIndex
CREATE INDEX "User_currentTeamId_idx" ON "User"("currentTeamId");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_token_key" ON "RefreshToken"("token");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "RefreshToken_token_idx" ON "RefreshToken"("token");

-- CreateIndex
CREATE INDEX "Player_clubId_idx" ON "Player"("clubId");

-- CreateIndex
CREATE INDEX "Player_position_idx" ON "Player"("position");

-- CreateIndex
CREATE INDEX "Player_isActive_idx" ON "Player"("isActive");

-- CreateIndex
CREATE INDEX "Player_medicalStatus_idx" ON "Player"("medicalStatus");

-- CreateIndex
CREATE INDEX "Player_paymentStatus_idx" ON "Player"("paymentStatus");

-- CreateIndex
CREATE INDEX "PlayerAuditLog_playerId_idx" ON "PlayerAuditLog"("playerId");

-- CreateIndex
CREATE INDEX "PlayerAuditLog_clubId_idx" ON "PlayerAuditLog"("clubId");

-- CreateIndex
CREATE INDEX "PlayerAuditLog_action_idx" ON "PlayerAuditLog"("action");

-- CreateIndex
CREATE INDEX "PlayerAuditLog_createdAt_idx" ON "PlayerAuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "Team_clubId_idx" ON "Team"("clubId");

-- CreateIndex
CREATE INDEX "Team_kind_idx" ON "Team"("kind");

-- CreateIndex
CREATE INDEX "Team_isActive_idx" ON "Team"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Team_clubId_name_key" ON "Team"("clubId", "name");

-- CreateIndex
CREATE INDEX "Membership_userId_idx" ON "Membership"("userId");

-- CreateIndex
CREATE INDEX "Membership_clubId_idx" ON "Membership"("clubId");

-- CreateIndex
CREATE INDEX "Membership_teamId_idx" ON "Membership"("teamId");

-- CreateIndex
CREATE INDEX "Membership_role_idx" ON "Membership"("role");

-- CreateIndex
CREATE INDEX "Membership_isActive_idx" ON "Membership"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_userId_clubId_teamId_role_key" ON "Membership"("userId", "clubId", "teamId", "role");

-- CreateIndex
CREATE INDEX "MembershipAuditLog_membershipId_idx" ON "MembershipAuditLog"("membershipId");

-- CreateIndex
CREATE INDEX "MembershipAuditLog_clubId_idx" ON "MembershipAuditLog"("clubId");

-- CreateIndex
CREATE INDEX "MembershipAuditLog_action_idx" ON "MembershipAuditLog"("action");

-- CreateIndex
CREATE INDEX "MembershipAuditLog_createdAt_idx" ON "MembershipAuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "PlayerAttribute_playerId_idx" ON "PlayerAttribute"("playerId");

-- CreateIndex
CREATE INDEX "PlayerGpsData_playerId_idx" ON "PlayerGpsData"("playerId");

-- CreateIndex
CREATE INDEX "PlayerGpsData_recordedAt_idx" ON "PlayerGpsData"("recordedAt");

-- CreateIndex
CREATE INDEX "PlayerInjury_playerId_idx" ON "PlayerInjury"("playerId");

-- CreateIndex
CREATE UNIQUE INDEX "Match_deviceSessionId_key" ON "Match"("deviceSessionId");

-- CreateIndex
CREATE INDEX "Match_clubId_idx" ON "Match"("clubId");

-- CreateIndex
CREATE INDEX "Match_teamId_idx" ON "Match"("teamId");

-- CreateIndex
CREATE INDEX "Match_status_idx" ON "Match"("status");

-- CreateIndex
CREATE INDEX "Match_scheduledAt_idx" ON "Match"("scheduledAt");

-- CreateIndex
CREATE INDEX "PlayerMatchStat_matchId_idx" ON "PlayerMatchStat"("matchId");

-- CreateIndex
CREATE INDEX "PlayerMatchStat_playerId_idx" ON "PlayerMatchStat"("playerId");

-- CreateIndex
CREATE UNIQUE INDEX "PlayerMatchStat_matchId_playerId_key" ON "PlayerMatchStat"("matchId", "playerId");

-- CreateIndex
CREATE INDEX "MatchLineup_matchId_idx" ON "MatchLineup"("matchId");

-- CreateIndex
CREATE UNIQUE INDEX "MatchLineup_matchId_side_key" ON "MatchLineup"("matchId", "side");

-- CreateIndex
CREATE INDEX "MatchTimeline_matchId_occurredAtMin_idx" ON "MatchTimeline"("matchId", "occurredAtMin");

-- CreateIndex
CREATE INDEX "MatchTimeline_matchId_kind_idx" ON "MatchTimeline"("matchId", "kind");

-- CreateIndex
CREATE INDEX "MatchTimeline_primaryPlayerId_idx" ON "MatchTimeline"("primaryPlayerId");

-- CreateIndex
CREATE INDEX "MatchTacticalSnapshot_matchId_takenAtMin_idx" ON "MatchTacticalSnapshot"("matchId", "takenAtMin");

-- CreateIndex
CREATE INDEX "MatchTacticalSnapshot_matchId_phase_idx" ON "MatchTacticalSnapshot"("matchId", "phase");

-- CreateIndex
CREATE INDEX "MatchAuditLog_matchId_idx" ON "MatchAuditLog"("matchId");

-- CreateIndex
CREATE INDEX "MatchAuditLog_clubId_idx" ON "MatchAuditLog"("clubId");

-- CreateIndex
CREATE INDEX "MatchAuditLog_action_idx" ON "MatchAuditLog"("action");

-- CreateIndex
CREATE INDEX "MatchAuditLog_createdAt_idx" ON "MatchAuditLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceSession_matchId_key" ON "DeviceSession"("matchId");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceSession_trainingSessionId_key" ON "DeviceSession"("trainingSessionId");

-- CreateIndex
CREATE INDEX "DeviceSession_clubId_idx" ON "DeviceSession"("clubId");

-- CreateIndex
CREATE INDEX "DeviceSession_teamId_idx" ON "DeviceSession"("teamId");

-- CreateIndex
CREATE INDEX "DeviceSession_deviceModel_idx" ON "DeviceSession"("deviceModel");

-- CreateIndex
CREATE INDEX "DeviceSession_deviceSerial_idx" ON "DeviceSession"("deviceSerial");

-- CreateIndex
CREATE INDEX "DeviceSession_startedAt_idx" ON "DeviceSession"("startedAt");

-- CreateIndex
CREATE INDEX "SensorPacket_deviceSessionId_capturedAt_idx" ON "SensorPacket"("deviceSessionId", "capturedAt");

-- CreateIndex
CREATE INDEX "SensorPacket_kind_idx" ON "SensorPacket"("kind");

-- CreateIndex
CREATE INDEX "AutomationTask_clubId_idx" ON "AutomationTask"("clubId");

-- CreateIndex
CREATE INDEX "AutomationTask_teamId_idx" ON "AutomationTask"("teamId");

-- CreateIndex
CREATE INDEX "AutomationTask_kind_idx" ON "AutomationTask"("kind");

-- CreateIndex
CREATE INDEX "AutomationTask_isActive_idx" ON "AutomationTask"("isActive");

-- CreateIndex
CREATE INDEX "AutomationRun_taskId_idx" ON "AutomationRun"("taskId");

-- CreateIndex
CREATE INDEX "AutomationRun_status_idx" ON "AutomationRun"("status");

-- CreateIndex
CREATE INDEX "AutomationRun_startedAt_idx" ON "AutomationRun"("startedAt");

-- CreateIndex
CREATE INDEX "AIAgentJob_clubId_idx" ON "AIAgentJob"("clubId");

-- CreateIndex
CREATE INDEX "AIAgentJob_agent_status_idx" ON "AIAgentJob"("agent", "status");

-- CreateIndex
CREATE INDEX "AIAgentJob_createdAt_idx" ON "AIAgentJob"("createdAt");

-- CreateIndex
CREATE INDEX "AIAlert_clubId_createdAt_idx" ON "AIAlert"("clubId", "createdAt");

-- CreateIndex
CREATE INDEX "AIAlert_clubId_status_idx" ON "AIAlert"("clubId", "status");

-- CreateIndex
CREATE INDEX "AIAlert_matchId_createdAt_idx" ON "AIAlert"("matchId", "createdAt");

-- CreateIndex
CREATE INDEX "AIAlert_kind_severity_idx" ON "AIAlert"("kind", "severity");

-- CreateIndex
CREATE INDEX "AIRecommendation_clubId_createdAt_idx" ON "AIRecommendation"("clubId", "createdAt");

-- CreateIndex
CREATE INDEX "AIRecommendation_matchId_createdAt_idx" ON "AIRecommendation"("matchId", "createdAt");

-- CreateIndex
CREATE INDEX "AIRecommendation_agent_status_idx" ON "AIRecommendation"("agent", "status");

-- CreateIndex
CREATE INDEX "AIReport_clubId_createdAt_idx" ON "AIReport"("clubId", "createdAt");

-- CreateIndex
CREATE INDEX "AIReport_matchId_createdAt_idx" ON "AIReport"("matchId", "createdAt");

-- CreateIndex
CREATE INDEX "AIReport_agent_kind_idx" ON "AIReport"("agent", "kind");

-- CreateIndex
CREATE INDEX "DigitalTwinFrame_matchId_takenAtMs_idx" ON "DigitalTwinFrame"("matchId", "takenAtMs");

-- CreateIndex
CREATE INDEX "DigitalTwinFrame_clubId_createdAt_idx" ON "DigitalTwinFrame"("clubId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Device_serial_key" ON "Device"("serial");

-- CreateIndex
CREATE INDEX "Device_clubId_idx" ON "Device"("clubId");

-- CreateIndex
CREATE INDEX "Device_clubId_status_idx" ON "Device"("clubId", "status");

-- CreateIndex
CREATE INDEX "Device_model_idx" ON "Device"("model");

-- CreateIndex
CREATE INDEX "DeviceFirmware_model_channel_isActive_idx" ON "DeviceFirmware"("model", "channel", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceFirmware_model_channel_version_key" ON "DeviceFirmware"("model", "channel", "version");

-- CreateIndex
CREATE INDEX "DeviceCalibration_deviceId_sensorKind_version_idx" ON "DeviceCalibration"("deviceId", "sensorKind", "version");

-- CreateIndex
CREATE INDEX "DeviceCalibration_deviceId_isActive_idx" ON "DeviceCalibration"("deviceId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "EventOutbox_idempotencyKey_key" ON "EventOutbox"("idempotencyKey");

-- CreateIndex
CREATE INDEX "EventOutbox_matchId_seq_idx" ON "EventOutbox"("matchId", "seq");

-- CreateIndex
CREATE INDEX "EventOutbox_clubId_createdAt_idx" ON "EventOutbox"("clubId", "createdAt");

-- CreateIndex
CREATE INDEX "EventOutbox_publishedAt_idx" ON "EventOutbox"("publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Camera_serial_key" ON "Camera"("serial");

-- CreateIndex
CREATE INDEX "Camera_clubId_idx" ON "Camera"("clubId");

-- CreateIndex
CREATE INDEX "Camera_clubId_status_idx" ON "Camera"("clubId", "status");

-- CreateIndex
CREATE INDEX "Camera_kind_idx" ON "Camera"("kind");

-- CreateIndex
CREATE INDEX "CameraCalibration_cameraId_version_idx" ON "CameraCalibration"("cameraId", "version");

-- CreateIndex
CREATE INDEX "CameraCalibration_cameraId_isActive_idx" ON "CameraCalibration"("cameraId", "isActive");

-- CreateIndex
CREATE INDEX "VisionFrame_matchId_monotonicMs_idx" ON "VisionFrame"("matchId", "monotonicMs");

-- CreateIndex
CREATE INDEX "VisionFrame_cameraId_monotonicMs_idx" ON "VisionFrame"("cameraId", "monotonicMs");

-- CreateIndex
CREATE INDEX "VisionFrame_clubId_monotonicMs_idx" ON "VisionFrame"("clubId", "monotonicMs");

-- CreateIndex
CREATE INDEX "SpatialFrame_matchId_monotonicMs_idx" ON "SpatialFrame"("matchId", "monotonicMs");

-- CreateIndex
CREATE INDEX "SpatialFrame_clubId_createdAt_idx" ON "SpatialFrame"("clubId", "createdAt");

-- CreateIndex
CREATE INDEX "TacticalAnnotation_matchId_atMs_idx" ON "TacticalAnnotation"("matchId", "atMs");

-- CreateIndex
CREATE INDEX "TacticalAnnotation_clubId_createdAt_idx" ON "TacticalAnnotation"("clubId", "createdAt");

-- CreateIndex
CREATE INDEX "Prediction_clubId_kind_createdAt_idx" ON "Prediction"("clubId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "Prediction_matchId_kind_idx" ON "Prediction"("matchId", "kind");

-- CreateIndex
CREATE INDEX "Prediction_playerId_kind_idx" ON "Prediction"("playerId", "kind");

-- CreateIndex
CREATE INDEX "SecurityAuditEvent_clubId_createdAt_idx" ON "SecurityAuditEvent"("clubId", "createdAt");

-- CreateIndex
CREATE INDEX "SecurityAuditEvent_currentHash_idx" ON "SecurityAuditEvent"("currentHash");

-- CreateIndex
CREATE UNIQUE INDEX "SecurityAuditEvent_clubId_chainPosition_key" ON "SecurityAuditEvent"("clubId", "chainPosition");

-- CreateIndex
CREATE INDEX "SecurityEvent_clubId_createdAt_idx" ON "SecurityEvent"("clubId", "createdAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_kind_createdAt_idx" ON "SecurityEvent"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_actorId_createdAt_idx" ON "SecurityEvent"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "LoginAttempt_emailHash_createdAt_idx" ON "LoginAttempt"("emailHash", "createdAt");

-- CreateIndex
CREATE INDEX "LoginAttempt_ipAddress_createdAt_idx" ON "LoginAttempt"("ipAddress", "createdAt");

-- CreateIndex
CREATE INDEX "AIApprovalRequest_clubId_status_idx" ON "AIApprovalRequest"("clubId", "status");

-- CreateIndex
CREATE INDEX "AIApprovalRequest_status_expiresAt_idx" ON "AIApprovalRequest"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "AIApprovalRequest_jobId_idx" ON "AIApprovalRequest"("jobId");

-- CreateIndex
CREATE INDEX "DeviceSecurityEvent_clubId_createdAt_idx" ON "DeviceSecurityEvent"("clubId", "createdAt");

-- CreateIndex
CREATE INDEX "DeviceSecurityEvent_deviceSessionId_createdAt_idx" ON "DeviceSecurityEvent"("deviceSessionId", "createdAt");

-- CreateIndex
CREATE INDEX "DeviceSecurityEvent_cameraId_createdAt_idx" ON "DeviceSecurityEvent"("cameraId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Region_code_key" ON "Region"("code");

-- CreateIndex
CREATE INDEX "Region_status_idx" ON "Region"("status");

-- CreateIndex
CREATE UNIQUE INDEX "RegionNode_nodeId_key" ON "RegionNode"("nodeId");

-- CreateIndex
CREATE INDEX "RegionNode_regionId_kind_idx" ON "RegionNode"("regionId", "kind");

-- CreateIndex
CREATE INDEX "RegionNode_lastSeenAt_idx" ON "RegionNode"("lastSeenAt");

-- CreateIndex
CREATE INDEX "RegionHeartbeat_regionId_capturedAt_idx" ON "RegionHeartbeat"("regionId", "capturedAt");

-- CreateIndex
CREATE INDEX "RegionHeartbeat_nodeId_capturedAt_idx" ON "RegionHeartbeat"("nodeId", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DistributedEventCursor_regionId_adapter_topic_key" ON "DistributedEventCursor"("regionId", "adapter", "topic");

-- CreateIndex
CREATE INDEX "AIAgentDecision_clubId_createdAt_idx" ON "AIAgentDecision"("clubId", "createdAt");

-- CreateIndex
CREATE INDEX "AIAgentDecision_matchId_agent_idx" ON "AIAgentDecision"("matchId", "agent");

-- CreateIndex
CREATE INDEX "AIAgentDecision_agent_kind_idx" ON "AIAgentDecision"("agent", "kind");

-- CreateIndex
CREATE INDEX "AIAgentDecision_jobId_idx" ON "AIAgentDecision"("jobId");

-- CreateIndex
CREATE INDEX "TacticalGhost_matchId_createdAt_idx" ON "TacticalGhost"("matchId", "createdAt");

-- CreateIndex
CREATE INDEX "TacticalGhost_clubId_createdAt_idx" ON "TacticalGhost"("clubId", "createdAt");

-- CreateIndex
CREATE INDEX "ReplayCursor_matchId_idx" ON "ReplayCursor"("matchId");

-- CreateIndex
CREATE UNIQUE INDEX "ReplayCursor_userId_matchId_key" ON "ReplayCursor"("userId", "matchId");

-- CreateIndex
CREATE INDEX "PoseSkeleton_matchId_monotonicMs_idx" ON "PoseSkeleton"("matchId", "monotonicMs");

-- CreateIndex
CREATE INDEX "PoseSkeleton_playerId_monotonicMs_idx" ON "PoseSkeleton"("playerId", "monotonicMs");

-- CreateIndex
CREATE INDEX "BallTrajectory_matchId_fromMs_idx" ON "BallTrajectory"("matchId", "fromMs");

-- CreateIndex
CREATE INDEX "SpatialMap_matchId_kind_idx" ON "SpatialMap"("matchId", "kind");

-- CreateIndex
CREATE INDEX "SpatialMap_clubId_createdAt_idx" ON "SpatialMap"("clubId", "createdAt");

-- CreateIndex
CREATE INDEX "EdgeNode_clubId_kind_idx" ON "EdgeNode"("clubId", "kind");

-- CreateIndex
CREATE INDEX "EdgeNode_deviceId_idx" ON "EdgeNode"("deviceId");

-- CreateIndex
CREATE INDEX "EdgeNode_cameraId_idx" ON "EdgeNode"("cameraId");

-- CreateIndex
CREATE INDEX "EdgeBuffer_edgeNodeId_capturedAt_idx" ON "EdgeBuffer"("edgeNodeId", "capturedAt");

-- CreateIndex
CREATE INDEX "EdgeBuffer_syncedAt_idx" ON "EdgeBuffer"("syncedAt");

-- CreateIndex
CREATE INDEX "SyncWindow_edgeNodeId_fromMs_idx" ON "SyncWindow"("edgeNodeId", "fromMs");

-- CreateIndex
CREATE INDEX "EdgeInferenceResult_edgeNodeId_capturedAt_idx" ON "EdgeInferenceResult"("edgeNodeId", "capturedAt");

-- CreateIndex
CREATE INDEX "EdgeInferenceResult_matchId_kind_idx" ON "EdgeInferenceResult"("matchId", "kind");

-- CreateIndex
CREATE INDEX "ProvisioningBatch_clubId_status_idx" ON "ProvisioningBatch"("clubId", "status");

-- CreateIndex
CREATE INDEX "ProvisioningBatch_model_status_idx" ON "ProvisioningBatch"("model", "status");

-- CreateIndex
CREATE INDEX "DeviceCertificate_deviceId_idx" ON "DeviceCertificate"("deviceId");

-- CreateIndex
CREATE INDEX "DeviceCertificate_revokedAt_idx" ON "DeviceCertificate"("revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceCertificate_deviceId_fingerprint_key" ON "DeviceCertificate"("deviceId", "fingerprint");

-- CreateIndex
CREATE INDEX "FirmwareManifest_model_channel_isActive_idx" ON "FirmwareManifest"("model", "channel", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "FirmwareManifest_model_channel_version_key" ON "FirmwareManifest"("model", "channel", "version");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceActivation_deviceId_key" ON "DeviceActivation"("deviceId");

-- CreateIndex
CREATE INDEX "DeviceActivation_batchId_idx" ON "DeviceActivation"("batchId");

-- CreateIndex
CREATE INDEX "DeviceActivation_status_idx" ON "DeviceActivation"("status");

-- CreateIndex
CREATE INDEX "OTARelease_model_channel_status_idx" ON "OTARelease"("model", "channel", "status");

-- CreateIndex
CREATE INDEX "OTARelease_manifestId_idx" ON "OTARelease"("manifestId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingPlanTier_code_key" ON "BillingPlanTier"("code");

-- CreateIndex
CREATE INDEX "BillingPlanTier_kind_isActive_idx" ON "BillingPlanTier"("kind", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "BillingAccount_clubId_key" ON "BillingAccount"("clubId");

-- CreateIndex
CREATE INDEX "BillingAccount_status_idx" ON "BillingAccount"("status");

-- CreateIndex
CREATE INDEX "DevicePlanAssignment_deviceId_idx" ON "DevicePlanAssignment"("deviceId");

-- CreateIndex
CREATE INDEX "DevicePlanAssignment_planTierId_idx" ON "DevicePlanAssignment"("planTierId");

-- CreateIndex
CREATE INDEX "UsageMeter_clubId_period_idx" ON "UsageMeter"("clubId", "period");

-- CreateIndex
CREATE INDEX "UsageMeter_kind_period_idx" ON "UsageMeter"("kind", "period");

-- CreateIndex
CREATE INDEX "InvoiceDraft_billingAccountId_periodFrom_idx" ON "InvoiceDraft"("billingAccountId", "periodFrom");

-- CreateIndex
CREATE INDEX "SystemMetric_name_capturedAt_idx" ON "SystemMetric"("name", "capturedAt");

-- CreateIndex
CREATE INDEX "SystemMetric_regionId_capturedAt_idx" ON "SystemMetric"("regionId", "capturedAt");

-- CreateIndex
CREATE INDEX "DeviceHealth_deviceId_capturedAt_idx" ON "DeviceHealth"("deviceId", "capturedAt");

-- CreateIndex
CREATE INDEX "RealtimeHealth_regionId_capturedAt_idx" ON "RealtimeHealth"("regionId", "capturedAt");

-- CreateIndex
CREATE INDEX "RealtimeHealth_kind_capturedAt_idx" ON "RealtimeHealth"("kind", "capturedAt");

-- CreateIndex
CREATE INDEX "AIWorkerHealth_workerId_capturedAt_idx" ON "AIWorkerHealth"("workerId", "capturedAt");

-- CreateIndex
CREATE INDEX "ReplayIntegrityMetric_matchId_capturedAt_idx" ON "ReplayIntegrityMetric"("matchId", "capturedAt");

-- CreateIndex
CREATE INDEX "EventCameraStream_clubId_openedAt_idx" ON "EventCameraStream"("clubId", "openedAt");

-- CreateIndex
CREATE INDEX "EventCameraStream_matchId_openedAt_idx" ON "EventCameraStream"("matchId", "openedAt");

-- CreateIndex
CREATE INDEX "EventCameraStream_status_idx" ON "EventCameraStream"("status");

-- CreateIndex
CREATE UNIQUE INDEX "EventCameraStream_cameraId_sessionRef_key" ON "EventCameraStream"("cameraId", "sessionRef");

-- CreateIndex
CREATE INDEX "VisionEventBatch_streamId_monotonicMs_idx" ON "VisionEventBatch"("streamId", "monotonicMs");

-- CreateIndex
CREATE INDEX "VisionEventBatch_matchId_monotonicMs_idx" ON "VisionEventBatch"("matchId", "monotonicMs");

-- CreateIndex
CREATE INDEX "VisionEventBatch_clubId_monotonicMs_idx" ON "VisionEventBatch"("clubId", "monotonicMs");

-- CreateIndex
CREATE INDEX "EventPoseEstimate_streamId_monotonicMs_idx" ON "EventPoseEstimate"("streamId", "monotonicMs");

-- CreateIndex
CREATE INDEX "EventPoseEstimate_playerId_monotonicMs_idx" ON "EventPoseEstimate"("playerId", "monotonicMs");

-- CreateIndex
CREATE INDEX "EventMotionCluster_streamId_monotonicMs_idx" ON "EventMotionCluster"("streamId", "monotonicMs");

-- CreateIndex
CREATE INDEX "EventMotionCluster_subjectKind_subjectId_idx" ON "EventMotionCluster"("subjectKind", "subjectId");

-- CreateIndex
CREATE INDEX "VisionTimestampSync_cameraId_isActive_idx" ON "VisionTimestampSync"("cameraId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "VisionTimestampSync_cameraId_sessionRef_version_key" ON "VisionTimestampSync"("cameraId", "sessionRef", "version");

-- CreateIndex
CREATE INDEX "CameraRig_clubId_idx" ON "CameraRig"("clubId");

-- CreateIndex
CREATE INDEX "CameraRigMember_cameraId_idx" ON "CameraRigMember"("cameraId");

-- CreateIndex
CREATE UNIQUE INDEX "CameraRigMember_rigId_cameraId_key" ON "CameraRigMember"("rigId", "cameraId");

-- CreateIndex
CREATE INDEX "CameraSyncSession_rigId_startedAt_idx" ON "CameraSyncSession"("rigId", "startedAt");

-- CreateIndex
CREATE INDEX "CameraSyncSession_matchId_startedAt_idx" ON "CameraSyncSession"("matchId", "startedAt");

-- CreateIndex
CREATE INDEX "MultiCameraObservation_syncSessionId_monotonicMs_idx" ON "MultiCameraObservation"("syncSessionId", "monotonicMs");

-- CreateIndex
CREATE INDEX "MultiCameraObservation_matchId_subjectKind_idx" ON "MultiCameraObservation"("matchId", "subjectKind");

-- CreateIndex
CREATE INDEX "SpatialTriangulationResult_syncSessionId_monotonicMs_idx" ON "SpatialTriangulationResult"("syncSessionId", "monotonicMs");

-- CreateIndex
CREATE INDEX "SpatialTriangulationResult_matchId_subjectId_idx" ON "SpatialTriangulationResult"("matchId", "subjectId");

-- CreateIndex
CREATE INDEX "VisualTacticalSignal_matchId_signalKind_monotonicMs_idx" ON "VisualTacticalSignal"("matchId", "signalKind", "monotonicMs");

-- CreateIndex
CREATE INDEX "VisualTacticalSignal_clubId_createdAt_idx" ON "VisualTacticalSignal"("clubId", "createdAt");

-- CreateIndex
CREATE INDEX "TacticalPatternDetection_matchId_patternKind_monotonicMs_idx" ON "TacticalPatternDetection"("matchId", "patternKind", "monotonicMs");

-- CreateIndex
CREATE INDEX "VisualFormationState_matchId_side_monotonicMs_idx" ON "VisualFormationState"("matchId", "side", "monotonicMs");

-- CreateIndex
CREATE INDEX "PressingIntensityEstimate_matchId_side_monotonicMs_idx" ON "PressingIntensityEstimate"("matchId", "side", "monotonicMs");

-- CreateIndex
CREATE INDEX "DefensiveLineEstimate_matchId_side_monotonicMs_idx" ON "DefensiveLineEstimate"("matchId", "side", "monotonicMs");

-- CreateIndex
CREATE INDEX "OverloadZoneEstimate_matchId_monotonicMs_idx" ON "OverloadZoneEstimate"("matchId", "monotonicMs");

-- CreateIndex
CREATE INDEX "EdgeVisionRuntime_clubId_status_idx" ON "EdgeVisionRuntime"("clubId", "status");

-- CreateIndex
CREATE INDEX "EdgeVisionRuntime_edgeNodeId_idx" ON "EdgeVisionRuntime"("edgeNodeId");

-- CreateIndex
CREATE INDEX "EdgeVisionRuntime_cameraId_idx" ON "EdgeVisionRuntime"("cameraId");

-- CreateIndex
CREATE UNIQUE INDEX "EdgeModelManifest_code_key" ON "EdgeModelManifest"("code");

-- CreateIndex
CREATE INDEX "EdgeModelVersion_manifestId_isActive_idx" ON "EdgeModelVersion"("manifestId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "EdgeModelVersion_manifestId_version_key" ON "EdgeModelVersion"("manifestId", "version");

-- CreateIndex
CREATE INDEX "EdgeVisionInference_runtimeId_monotonicMs_idx" ON "EdgeVisionInference"("runtimeId", "monotonicMs");

-- CreateIndex
CREATE INDEX "EdgeVisionInference_matchId_kind_idx" ON "EdgeVisionInference"("matchId", "kind");

-- CreateIndex
CREATE INDEX "EdgeVisionHealth_runtimeId_capturedAt_idx" ON "EdgeVisionHealth"("runtimeId", "capturedAt");

-- CreateIndex
CREATE INDEX "BiomechanicalPacket_playerId_monotonicMs_idx" ON "BiomechanicalPacket"("playerId", "monotonicMs");

-- CreateIndex
CREATE INDEX "BiomechanicalPacket_matchId_monotonicMs_idx" ON "BiomechanicalPacket"("matchId", "monotonicMs");

-- CreateIndex
CREATE INDEX "BiomechanicalPacket_clubId_createdAt_idx" ON "BiomechanicalPacket"("clubId", "createdAt");

-- CreateIndex
CREATE INDEX "HardwareProvisioningSession_clubId_status_idx" ON "HardwareProvisioningSession"("clubId", "status");

-- CreateIndex
CREATE INDEX "HardwareProvisioningSession_deviceId_idx" ON "HardwareProvisioningSession"("deviceId");

-- CreateIndex
CREATE INDEX "HardwareProvisioningSession_serial_idx" ON "HardwareProvisioningSession"("serial");

-- CreateIndex
CREATE INDEX "DeviceCapabilityProfile_model_isActive_idx" ON "DeviceCapabilityProfile"("model", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceCapabilityProfile_model_hwRevision_key" ON "DeviceCapabilityProfile"("model", "hwRevision");

-- CreateIndex
CREATE INDEX "DeviceSensorMatrix_deviceId_isActive_idx" ON "DeviceSensorMatrix"("deviceId", "isActive");

-- CreateIndex
CREATE INDEX "DeviceClockDiscipline_deviceId_capturedAt_idx" ON "DeviceClockDiscipline"("deviceId", "capturedAt");

-- CreateIndex
CREATE INDEX "DeviceTrustAnchor_deviceId_idx" ON "DeviceTrustAnchor"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceTrustAnchor_deviceId_certFingerprint_key" ON "DeviceTrustAnchor"("deviceId", "certFingerprint");

-- CreateIndex
CREATE INDEX "DeviceAttestation_deviceId_capturedAt_idx" ON "DeviceAttestation"("deviceId", "capturedAt");

-- CreateIndex
CREATE INDEX "DeviceAttestation_status_idx" ON "DeviceAttestation"("status");

-- CreateIndex
CREATE INDEX "FederatedTrainingJob_modelFamily_roundNumber_idx" ON "FederatedTrainingJob"("modelFamily", "roundNumber");

-- CreateIndex
CREATE INDEX "FederatedTrainingJob_status_sport_idx" ON "FederatedTrainingJob"("status", "sport");

-- CreateIndex
CREATE INDEX "FederatedGradientEnvelope_jobId_idx" ON "FederatedGradientEnvelope"("jobId");

-- CreateIndex
CREATE INDEX "FederatedGradientEnvelope_clubId_createdAt_idx" ON "FederatedGradientEnvelope"("clubId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FederatedGradientEnvelope_jobId_clubId_nonce_key" ON "FederatedGradientEnvelope"("jobId", "clubId", "nonce");

-- CreateIndex
CREATE INDEX "FederatedModelCheckpoint_jobId_idx" ON "FederatedModelCheckpoint"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "FederatedModelCheckpoint_jobId_version_key" ON "FederatedModelCheckpoint"("jobId", "version");

-- CreateIndex
CREATE INDEX "ClubModelPartition_modelFamily_active_idx" ON "ClubModelPartition"("modelFamily", "active");

-- CreateIndex
CREATE UNIQUE INDEX "ClubModelPartition_clubId_modelFamily_partitionKey_key" ON "ClubModelPartition"("clubId", "modelFamily", "partitionKey");

-- CreateIndex
CREATE INDEX "PrivacyBoundary_modelFamily_isActive_idx" ON "PrivacyBoundary"("modelFamily", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "PrivacyBoundary_modelFamily_key" ON "PrivacyBoundary"("modelFamily");

-- CreateIndex
CREATE INDEX "AggregatedSportsModel_modelFamily_isActive_idx" ON "AggregatedSportsModel"("modelFamily", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "AggregatedSportsModel_modelFamily_version_key" ON "AggregatedSportsModel"("modelFamily", "version");

-- CreateIndex
CREATE INDEX "FederatedTrustBoundary_modelFamily_trusted_idx" ON "FederatedTrustBoundary"("modelFamily", "trusted");

-- CreateIndex
CREATE UNIQUE INDEX "FederatedTrustBoundary_modelFamily_clubId_key" ON "FederatedTrustBoundary"("modelFamily", "clubId");

-- CreateIndex
CREATE INDEX "CoachAgent_clubId_isActive_idx" ON "CoachAgent"("clubId", "isActive");

-- CreateIndex
CREATE INDEX "CoachRecommendation_clubId_kind_createdAt_idx" ON "CoachRecommendation"("clubId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "CoachRecommendation_matchId_kind_idx" ON "CoachRecommendation"("matchId", "kind");

-- CreateIndex
CREATE INDEX "CoachRecommendation_playerId_kind_idx" ON "CoachRecommendation"("playerId", "kind");

-- CreateIndex
CREATE INDEX "TwinSimulationSession_clubId_status_idx" ON "TwinSimulationSession"("clubId", "status");

-- CreateIndex
CREATE INDEX "TwinSimulationSession_matchId_status_idx" ON "TwinSimulationSession"("matchId", "status");

-- CreateIndex
CREATE INDEX "MatchSimulationState_sessionId_tickMs_idx" ON "MatchSimulationState"("sessionId", "tickMs");

-- CreateIndex
CREATE INDEX "MatchSimulationState_branchId_tickMs_idx" ON "MatchSimulationState"("branchId", "tickMs");

-- CreateIndex
CREATE INDEX "TacticalBranch_sessionId_idx" ON "TacticalBranch"("sessionId");

-- CreateIndex
CREATE INDEX "TacticalBranch_parentBranchId_idx" ON "TacticalBranch"("parentBranchId");

-- CreateIndex
CREATE INDEX "PredictedPossessionFlow_sessionId_branchId_idx" ON "PredictedPossessionFlow"("sessionId", "branchId");

-- CreateIndex
CREATE INDEX "PredictedFatigueCurve_sessionId_branchId_idx" ON "PredictedFatigueCurve"("sessionId", "branchId");

-- CreateIndex
CREATE INDEX "PredictedFatigueCurve_playerId_idx" ON "PredictedFatigueCurve"("playerId");

-- CreateIndex
CREATE INDEX "CounterfactualScenario_sessionId_idx" ON "CounterfactualScenario"("sessionId");

-- CreateIndex
CREATE INDEX "GameGraph_matchId_monotonicMs_idx" ON "GameGraph"("matchId", "monotonicMs");

-- CreateIndex
CREATE INDEX "SpatialPressureGraph_matchId_monotonicMs_idx" ON "SpatialPressureGraph"("matchId", "monotonicMs");

-- CreateIndex
CREATE INDEX "PassingNetworkGraph_matchId_monotonicMs_idx" ON "PassingNetworkGraph"("matchId", "monotonicMs");

-- CreateIndex
CREATE INDEX "DynamicThreatMap_matchId_monotonicMs_idx" ON "DynamicThreatMap"("matchId", "monotonicMs");

-- CreateIndex
CREATE INDEX "CognitiveInfluenceScore_matchId_monotonicMs_idx" ON "CognitiveInfluenceScore"("matchId", "monotonicMs");

-- CreateIndex
CREATE INDEX "CognitiveInfluenceScore_playerId_monotonicMs_idx" ON "CognitiveInfluenceScore"("playerId", "monotonicMs");

-- CreateIndex
CREATE INDEX "BiochemicalSignal_playerId_kind_monotonicMs_idx" ON "BiochemicalSignal"("playerId", "kind", "monotonicMs");

-- CreateIndex
CREATE INDEX "BiochemicalSignal_matchId_kind_idx" ON "BiochemicalSignal"("matchId", "kind");

-- CreateIndex
CREATE INDEX "HydrationEstimate_playerId_monotonicMs_idx" ON "HydrationEstimate"("playerId", "monotonicMs");

-- CreateIndex
CREATE INDEX "StressIndex_playerId_monotonicMs_idx" ON "StressIndex"("playerId", "monotonicMs");

-- CreateIndex
CREATE INDEX "NeuromuscularLoad_playerId_monotonicMs_idx" ON "NeuromuscularLoad"("playerId", "monotonicMs");

-- CreateIndex
CREATE INDEX "TendonRiskEstimate_playerId_monotonicMs_idx" ON "TendonRiskEstimate"("playerId", "monotonicMs");

-- CreateIndex
CREATE INDEX "TendonRiskEstimate_region_idx" ON "TendonRiskEstimate"("region");

-- CreateIndex
CREATE INDEX "SportPlugin_sport_isActive_idx" ON "SportPlugin"("sport", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "SportPlugin_sport_code_key" ON "SportPlugin"("sport", "code");

-- CreateIndex
CREATE UNIQUE INDEX "TacticalDomain_sport_code_key" ON "TacticalDomain"("sport", "code");

-- CreateIndex
CREATE UNIQUE INDEX "SportFieldGeometry_sport_pluginCode_key" ON "SportFieldGeometry"("sport", "pluginCode");

-- CreateIndex
CREATE UNIQUE INDEX "SportEventTaxonomy_sport_eventKind_key" ON "SportEventTaxonomy"("sport", "eventKind");

-- CreateIndex
CREATE UNIQUE INDEX "SportSpatialRules_sport_pluginCode_key" ON "SportSpatialRules"("sport", "pluginCode");

-- CreateIndex
CREATE INDEX "RegionalHealthSnapshot_regionId_capturedAt_idx" ON "RegionalHealthSnapshot"("regionId", "capturedAt");

-- CreateIndex
CREATE INDEX "DeviceFleetHealth_clubId_capturedAt_idx" ON "DeviceFleetHealth"("clubId", "capturedAt");

-- CreateIndex
CREATE INDEX "DeviceFleetHealth_model_capturedAt_idx" ON "DeviceFleetHealth"("model", "capturedAt");

-- CreateIndex
CREATE INDEX "AIConsensusHealth_matchId_capturedAt_idx" ON "AIConsensusHealth"("matchId", "capturedAt");

-- CreateIndex
CREATE INDEX "FederatedAggregationHealth_jobId_idx" ON "FederatedAggregationHealth"("jobId");

-- CreateIndex
CREATE INDEX "SimulationQueueHealth_capturedAt_idx" ON "SimulationQueueHealth"("capturedAt");

-- CreateIndex
CREATE INDEX "OrganizationTwin_clubId_capturedAt_idx" ON "OrganizationTwin"("clubId", "capturedAt");

-- CreateIndex
CREATE INDEX "ClubTwin_clubId_capturedAt_idx" ON "ClubTwin"("clubId", "capturedAt");

-- CreateIndex
CREATE INDEX "AcademyTwin_clubId_capturedAt_idx" ON "AcademyTwin"("clubId", "capturedAt");

-- CreateIndex
CREATE INDEX "DepartmentTwin_clubId_department_idx" ON "DepartmentTwin"("clubId", "department");

-- CreateIndex
CREATE INDEX "StaffTwin_clubId_staffKind_idx" ON "StaffTwin"("clubId", "staffKind");

-- CreateIndex
CREATE INDEX "ExecutiveAgent_clubId_role_idx" ON "ExecutiveAgent"("clubId", "role");

-- CreateIndex
CREATE INDEX "ExecutiveDecision_clubId_kind_createdAt_idx" ON "ExecutiveDecision"("clubId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "DecisionCouncil_clubId_status_idx" ON "DecisionCouncil"("clubId", "status");

-- CreateIndex
CREATE INDEX "CouncilVote_councilId_idx" ON "CouncilVote"("councilId");

-- CreateIndex
CREATE UNIQUE INDEX "CouncilVote_councilId_voterId_key" ON "CouncilVote"("councilId", "voterId");

-- CreateIndex
CREATE INDEX "PlayerTarget_clubId_status_idx" ON "PlayerTarget"("clubId", "status");

-- CreateIndex
CREATE INDEX "PlayerTarget_clubId_position_idx" ON "PlayerTarget"("clubId", "position");

-- CreateIndex
CREATE INDEX "RecruitmentScoutReport_playerTargetId_idx" ON "RecruitmentScoutReport"("playerTargetId");

-- CreateIndex
CREATE INDEX "RecruitmentScoutReport_playerId_idx" ON "RecruitmentScoutReport"("playerId");

-- CreateIndex
CREATE INDEX "RecruitmentScoutReport_clubId_createdAt_idx" ON "RecruitmentScoutReport"("clubId", "createdAt");

-- CreateIndex
CREATE INDEX "RecruitmentScore_clubId_createdAt_idx" ON "RecruitmentScore"("clubId", "createdAt");

-- CreateIndex
CREATE INDEX "RecruitmentScore_playerTargetId_idx" ON "RecruitmentScore"("playerTargetId");

-- CreateIndex
CREATE INDEX "RecruitmentScore_playerId_idx" ON "RecruitmentScore"("playerId");

-- CreateIndex
CREATE INDEX "TransferProbability_clubId_createdAt_idx" ON "TransferProbability"("clubId", "createdAt");

-- CreateIndex
CREATE INDEX "TalentProjection_clubId_createdAt_idx" ON "TalentProjection"("clubId", "createdAt");

-- CreateIndex
CREATE INDEX "TrainingOptimizationPlan_clubId_weekStart_idx" ON "TrainingOptimizationPlan"("clubId", "weekStart");

-- CreateIndex
CREATE INDEX "RecoveryPlan_clubId_playerId_fromDate_idx" ON "RecoveryPlan"("clubId", "playerId", "fromDate");

-- CreateIndex
CREATE INDEX "LoadDistributionPlan_clubId_weekStart_idx" ON "LoadDistributionPlan"("clubId", "weekStart");

-- CreateIndex
CREATE INDEX "MicrocyclePlan_clubId_weekStart_idx" ON "MicrocyclePlan"("clubId", "weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "SeasonPlan_clubId_season_key" ON "SeasonPlan"("clubId", "season");

-- CreateIndex
CREATE INDEX "PlayerAssetValue_clubId_playerId_createdAt_idx" ON "PlayerAssetValue"("clubId", "playerId", "createdAt");

-- CreateIndex
CREATE INDEX "ContractRisk_clubId_playerId_createdAt_idx" ON "ContractRisk"("clubId", "playerId", "createdAt");

-- CreateIndex
CREATE INDEX "SponsorImpact_clubId_channelKind_idx" ON "SponsorImpact"("clubId", "channelKind");

-- CreateIndex
CREATE INDEX "CommercialScore_clubId_scope_refId_idx" ON "CommercialScore"("clubId", "scope", "refId");

-- CreateIndex
CREATE UNIQUE INDEX "AcademyROI_clubId_academyName_season_key" ON "AcademyROI"("clubId", "academyName", "season");

-- CreateIndex
CREATE INDEX "TalentGraph_clubId_monotonicMs_idx" ON "TalentGraph"("clubId", "monotonicMs");

-- CreateIndex
CREATE INDEX "ScoutNetwork_clubId_isActive_idx" ON "ScoutNetwork"("clubId", "isActive");

-- CreateIndex
CREATE INDEX "ScoutNetwork_scoutUserId_idx" ON "ScoutNetwork"("scoutUserId");

-- CreateIndex
CREATE INDEX "PlayerSimilarityGraph_sourcePlayerId_idx" ON "PlayerSimilarityGraph"("sourcePlayerId");

-- CreateIndex
CREATE INDEX "CareerProjectionGraph_clubId_playerId_idx" ON "CareerProjectionGraph"("clubId", "playerId");

-- CreateIndex
CREATE INDEX "MarketplaceItem_clubId_kind_status_idx" ON "MarketplaceItem"("clubId", "kind", "status");

-- CreateIndex
CREATE INDEX "MarketplaceItem_status_validFrom_idx" ON "MarketplaceItem"("status", "validFrom");

-- CreateIndex
CREATE INDEX "KnowledgeDocument_clubId_kind_isActive_idx" ON "KnowledgeDocument"("clubId", "kind", "isActive");

-- CreateIndex
CREATE INDEX "KnowledgeGraph_clubId_createdAt_idx" ON "KnowledgeGraph"("clubId", "createdAt");

-- CreateIndex
CREATE INDEX "TacticalPatternLibrary_sport_isActive_idx" ON "TacticalPatternLibrary"("sport", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "TacticalPatternLibrary_sport_pluginCode_patternName_key" ON "TacticalPatternLibrary"("sport", "pluginCode", "patternName");

-- CreateIndex
CREATE INDEX "MedicalKnowledgeNode_clubId_kind_isActive_idx" ON "MedicalKnowledgeNode"("clubId", "kind", "isActive");

-- CreateIndex
CREATE INDEX "GlobalKnowledgeNode_clubId_nodeKind_idx" ON "GlobalKnowledgeNode"("clubId", "nodeKind");

-- CreateIndex
CREATE INDEX "GlobalKnowledgeNode_nodeKind_isActive_idx" ON "GlobalKnowledgeNode"("nodeKind", "isActive");

-- CreateIndex
CREATE INDEX "GlobalKnowledgeNode_externalRef_idx" ON "GlobalKnowledgeNode"("externalRef");

-- CreateIndex
CREATE INDEX "GlobalKnowledgeEdge_clubId_edgeKind_idx" ON "GlobalKnowledgeEdge"("clubId", "edgeKind");

-- CreateIndex
CREATE INDEX "GlobalKnowledgeEdge_fromNodeId_idx" ON "GlobalKnowledgeEdge"("fromNodeId");

-- CreateIndex
CREATE INDEX "GlobalKnowledgeEdge_toNodeId_idx" ON "GlobalKnowledgeEdge"("toNodeId");

-- CreateIndex
CREATE UNIQUE INDEX "GlobalKnowledgeEdge_fromNodeId_toNodeId_edgeKind_key" ON "GlobalKnowledgeEdge"("fromNodeId", "toNodeId", "edgeKind");

-- CreateIndex
CREATE UNIQUE INDEX "UniversalAthleteId_idHash_key" ON "UniversalAthleteId"("idHash");

-- CreateIndex
CREATE INDEX "UniversalAthleteId_sport_idx" ON "UniversalAthleteId"("sport");

-- CreateIndex
CREATE INDEX "AthleteIdentityLink_playerId_idx" ON "AthleteIdentityLink"("playerId");

-- CreateIndex
CREATE INDEX "AthleteIdentityLink_clubId_idx" ON "AthleteIdentityLink"("clubId");

-- CreateIndex
CREATE UNIQUE INDEX "AthleteIdentityLink_athleteId_playerId_key" ON "AthleteIdentityLink"("athleteId", "playerId");

-- CreateIndex
CREATE INDEX "AthletePerformanceHistory_athleteId_season_idx" ON "AthletePerformanceHistory"("athleteId", "season");

-- CreateIndex
CREATE INDEX "AthleteMedicalHistory_athleteId_recordKind_idx" ON "AthleteMedicalHistory"("athleteId", "recordKind");

-- CreateIndex
CREATE INDEX "AthleteTransferHistory_athleteId_occurredAt_idx" ON "AthleteTransferHistory"("athleteId", "occurredAt");

-- CreateIndex
CREATE INDEX "TalentEvolutionGraph_athleteId_capturedAt_idx" ON "TalentEvolutionGraph"("athleteId", "capturedAt");

-- CreateIndex
CREATE INDEX "WorldwideScoutingNode_regionCode_isActive_idx" ON "WorldwideScoutingNode"("regionCode", "isActive");

-- CreateIndex
CREATE INDEX "WorldwideScoutingNode_clubId_isActive_idx" ON "WorldwideScoutingNode"("clubId", "isActive");

-- CreateIndex
CREATE INDEX "TalentDiscoveryEvent_clubId_status_idx" ON "TalentDiscoveryEvent"("clubId", "status");

-- CreateIndex
CREATE INDEX "TalentDiscoveryEvent_scoutingNodeId_idx" ON "TalentDiscoveryEvent"("scoutingNodeId");

-- CreateIndex
CREATE INDEX "TalentDiscoveryEvent_athleteIdHash_idx" ON "TalentDiscoveryEvent"("athleteIdHash");

-- CreateIndex
CREATE INDEX "GlobalRecommendationRanking_clubId_position_createdAt_idx" ON "GlobalRecommendationRanking"("clubId", "position", "createdAt");

-- CreateIndex
CREATE INDEX "GlobalRecommendationRanking_discoveryId_idx" ON "GlobalRecommendationRanking"("discoveryId");

-- CreateIndex
CREATE INDEX "ConfidenceScore_clubId_sourceKind_idx" ON "ConfidenceScore"("clubId", "sourceKind");

-- CreateIndex
CREATE INDEX "ConfidenceScore_sourceRef_idx" ON "ConfidenceScore"("sourceRef");

-- CreateIndex
CREATE INDEX "ScoutingEvaluation_clubId_createdAt_idx" ON "ScoutingEvaluation"("clubId", "createdAt");

-- CreateIndex
CREATE INDEX "ScoutingEvaluation_discoveryId_idx" ON "ScoutingEvaluation"("discoveryId");

-- CreateIndex
CREATE INDEX "MarketTransferPrediction_clubId_createdAt_idx" ON "MarketTransferPrediction"("clubId", "createdAt");

-- CreateIndex
CREATE INDEX "MarketTransferPrediction_athleteIdHash_idx" ON "MarketTransferPrediction"("athleteIdHash");

-- CreateIndex
CREATE INDEX "ContractIntelligenceSnapshot_clubId_signal_createdAt_idx" ON "ContractIntelligenceSnapshot"("clubId", "signal", "createdAt");

-- CreateIndex
CREATE INDEX "AcademyDevelopmentForecast_clubId_academyName_createdAt_idx" ON "AcademyDevelopmentForecast"("clubId", "academyName", "createdAt");

-- CreateIndex
CREATE INDEX "ReasoningTrace_clubId_kind_createdAt_idx" ON "ReasoningTrace"("clubId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "ExplainableDecision_clubId_createdAt_idx" ON "ExplainableDecision"("clubId", "createdAt");

-- CreateIndex
CREATE INDEX "ExplainableDecision_traceId_idx" ON "ExplainableDecision"("traceId");

-- CreateIndex
CREATE INDEX "DeterministicReasoningRule_kind_isActive_idx" ON "DeterministicReasoningRule"("kind", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "DeterministicReasoningRule_clubId_code_version_key" ON "DeterministicReasoningRule"("clubId", "code", "version");

-- CreateIndex
CREATE INDEX "CryptographicGraphAnchor_clubId_anchorKind_asOf_idx" ON "CryptographicGraphAnchor"("clubId", "anchorKind", "asOf");

-- CreateIndex
CREATE INDEX "CryptographicGraphAnchor_sha256_idx" ON "CryptographicGraphAnchor"("sha256");

-- CreateIndex
CREATE INDEX "RecommendationSignature_clubId_createdAt_idx" ON "RecommendationSignature"("clubId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RecommendationSignature_recommendationId_recommendationKind_key" ON "RecommendationSignature"("recommendationId", "recommendationKind");

-- CreateIndex
CREATE INDEX "TrustScore_sourceKind_idx" ON "TrustScore"("sourceKind");

-- CreateIndex
CREATE UNIQUE INDEX "TrustScore_clubId_sourceKind_sourceRef_key" ON "TrustScore"("clubId", "sourceKind", "sourceRef");

-- CreateIndex
CREATE UNIQUE INDEX "AuthSession_refreshHash_key" ON "AuthSession"("refreshHash");

-- CreateIndex
CREATE INDEX "AuthSession_userId_status_idx" ON "AuthSession"("userId", "status");

-- CreateIndex
CREATE INDEX "AuthSession_expiresAt_idx" ON "AuthSession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "MFASetting_userId_key" ON "MFASetting"("userId");

-- CreateIndex
CREATE INDEX "MFAChallenge_userId_expiresAt_idx" ON "MFAChallenge"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "PlayerGuardianLink_clubId_playerId_idx" ON "PlayerGuardianLink"("clubId", "playerId");

-- CreateIndex
CREATE INDEX "PlayerGuardianLink_guardianUserId_idx" ON "PlayerGuardianLink"("guardianUserId");

-- CreateIndex
CREATE UNIQUE INDEX "PlayerGuardianLink_playerId_guardianUserId_key" ON "PlayerGuardianLink"("playerId", "guardianUserId");

-- CreateIndex
CREATE INDEX "TrainingAttendanceRecord_clubId_recordedAt_idx" ON "TrainingAttendanceRecord"("clubId", "recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingAttendanceRecord_trainingSessionId_playerId_key" ON "TrainingAttendanceRecord"("trainingSessionId", "playerId");

-- CreateIndex
CREATE INDEX "MatchAttendanceRecord_clubId_matchId_idx" ON "MatchAttendanceRecord"("clubId", "matchId");

-- CreateIndex
CREATE UNIQUE INDEX "MatchAttendanceRecord_matchId_playerId_key" ON "MatchAttendanceRecord"("matchId", "playerId");

-- CreateIndex
CREATE INDEX "OperationsPayment_clubId_state_dueDate_idx" ON "OperationsPayment"("clubId", "state", "dueDate");

-- CreateIndex
CREATE INDEX "OperationsPayment_payerPlayerId_idx" ON "OperationsPayment"("payerPlayerId");

-- CreateIndex
CREATE INDEX "OperationsInvoiceLine_invoiceDraftId_idx" ON "OperationsInvoiceLine"("invoiceDraftId");

-- CreateIndex
CREATE INDEX "ClubCalendarEntry_clubId_startsAt_idx" ON "ClubCalendarEntry"("clubId", "startsAt");

-- CreateIndex
CREATE INDEX "ClubCalendarEntry_teamId_startsAt_idx" ON "ClubCalendarEntry"("teamId", "startsAt");

-- CreateIndex
CREATE INDEX "PlayerOnboardingStep_clubId_completed_idx" ON "PlayerOnboardingStep"("clubId", "completed");

-- CreateIndex
CREATE UNIQUE INDEX "PlayerOnboardingStep_playerId_step_key" ON "PlayerOnboardingStep"("playerId", "step");

-- CreateIndex
CREATE INDEX "PlayerEvaluationRecord_playerId_kind_createdAt_idx" ON "PlayerEvaluationRecord"("playerId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "PlayerEvaluationRecord_clubId_createdAt_idx" ON "PlayerEvaluationRecord"("clubId", "createdAt");

-- CreateIndex
CREATE INDEX "PlayerContractRecord_clubId_playerId_state_idx" ON "PlayerContractRecord"("clubId", "playerId", "state");

-- CreateIndex
CREATE INDEX "PlayerContractRecord_endsAt_idx" ON "PlayerContractRecord"("endsAt");

-- CreateIndex
CREATE INDEX "DeviceInventoryEntry_clubId_state_idx" ON "DeviceInventoryEntry"("clubId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceInventoryEntry_serial_key" ON "DeviceInventoryEntry"("serial");

-- CreateIndex
CREATE INDEX "DeviceDiagnosticReport_deviceId_capturedAt_idx" ON "DeviceDiagnosticReport"("deviceId", "capturedAt");

-- CreateIndex
CREATE INDEX "DeviceDiagnosticReport_reportKind_idx" ON "DeviceDiagnosticReport"("reportKind");

-- CreateIndex
CREATE INDEX "UserNotificationChannel_userId_isActive_idx" ON "UserNotificationChannel"("userId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "UserNotificationChannel_userId_channel_target_key" ON "UserNotificationChannel"("userId", "channel", "target");

-- CreateIndex
CREATE INDEX "OpsReportTemplate_code_isActive_idx" ON "OpsReportTemplate"("code", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "OpsReportTemplate_clubId_code_key" ON "OpsReportTemplate"("clubId", "code");

-- CreateIndex
CREATE INDEX "OpsReportRun_clubId_startedAt_idx" ON "OpsReportRun"("clubId", "startedAt");

-- CreateIndex
CREATE INDEX "OpsReportRun_templateId_idx" ON "OpsReportRun"("templateId");

-- CreateIndex
CREATE INDEX "DataRetentionPolicy_entityType_isActive_idx" ON "DataRetentionPolicy"("entityType", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "DataRetentionPolicy_clubId_entityType_key" ON "DataRetentionPolicy"("clubId", "entityType");

-- CreateIndex
CREATE INDEX "GdprDataRequest_clubId_kind_state_idx" ON "GdprDataRequest"("clubId", "kind", "state");

-- CreateIndex
CREATE INDEX "GdprDataRequest_subjectUserId_idx" ON "GdprDataRequest"("subjectUserId");

-- CreateIndex
CREATE INDEX "GdprDataRequest_subjectPlayerId_idx" ON "GdprDataRequest"("subjectPlayerId");

-- CreateIndex
CREATE INDEX "UserConsentRecord_userId_scope_idx" ON "UserConsentRecord"("userId", "scope");

-- CreateIndex
CREATE INDEX "UserConsentRecord_playerId_scope_idx" ON "UserConsentRecord"("playerId", "scope");

-- CreateIndex
CREATE INDEX "UserConsentRecord_clubId_scope_idx" ON "UserConsentRecord"("clubId", "scope");

-- CreateIndex
CREATE INDEX "ProductionHealthCheck_service_capturedAt_idx" ON "ProductionHealthCheck"("service", "capturedAt");

-- CreateIndex
CREATE INDEX "ProductionHealthCheck_state_capturedAt_idx" ON "ProductionHealthCheck"("state", "capturedAt");

-- CreateIndex
CREATE INDEX "ProductionAlertRule_state_idx" ON "ProductionAlertRule"("state");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionAlertRule_clubId_code_key" ON "ProductionAlertRule"("clubId", "code");

-- CreateIndex
CREATE INDEX "BackupRecord_kind_startedAt_idx" ON "BackupRecord"("kind", "startedAt");

-- CreateIndex
CREATE INDEX "UserNotification_clubId_idx" ON "UserNotification"("clubId");

-- CreateIndex
CREATE INDEX "UserNotification_userId_archived_readAt_idx" ON "UserNotification"("userId", "archived", "readAt");

-- CreateIndex
CREATE INDEX "UserNotification_createdAt_idx" ON "UserNotification"("createdAt");

-- CreateIndex
CREATE INDEX "Tournament_clubId_idx" ON "Tournament"("clubId");

-- CreateIndex
CREATE INDEX "TrainingSession_clubId_idx" ON "TrainingSession"("clubId");

-- CreateIndex
CREATE INDEX "TrainingSession_scheduledAt_idx" ON "TrainingSession"("scheduledAt");

-- CreateIndex
CREATE INDEX "PlayerTrainingStat_sessionId_idx" ON "PlayerTrainingStat"("sessionId");

-- CreateIndex
CREATE INDEX "PlayerTrainingStat_playerId_idx" ON "PlayerTrainingStat"("playerId");

-- CreateIndex
CREATE UNIQUE INDEX "PlayerTrainingStat_sessionId_playerId_key" ON "PlayerTrainingStat"("sessionId", "playerId");

-- CreateIndex
CREATE UNIQUE INDEX "GpsDevice_serialNumber_key" ON "GpsDevice"("serialNumber");

-- CreateIndex
CREATE UNIQUE INDEX "GpsDevice_playerId_key" ON "GpsDevice"("playerId");

-- CreateIndex
CREATE INDEX "GpsDevice_clubId_idx" ON "GpsDevice"("clubId");

-- CreateIndex
CREATE INDEX "ScoutReport_clubId_idx" ON "ScoutReport"("clubId");

-- CreateIndex
CREATE INDEX "Financial_clubId_idx" ON "Financial"("clubId");

-- CreateIndex
CREATE INDEX "Financial_date_idx" ON "Financial"("date");

-- CreateIndex
CREATE INDEX "Financial_type_idx" ON "Financial"("type");

-- CreateIndex
CREATE INDEX "AiInsight_clubId_idx" ON "AiInsight"("clubId");

-- CreateIndex
CREATE INDEX "AiInsight_userId_idx" ON "AiInsight"("userId");

-- CreateIndex
CREATE INDEX "AiInsight_type_idx" ON "AiInsight"("type");

-- CreateIndex
CREATE UNIQUE INDEX "WhiteLabelConfig_clubId_key" ON "WhiteLabelConfig"("clubId");

-- CreateIndex
CREATE INDEX "WhiteLabelConfig_clubId_idx" ON "WhiteLabelConfig"("clubId");

-- CreateIndex
CREATE INDEX "WhiteLabelConfig_isActive_idx" ON "WhiteLabelConfig"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "WhiteLabelDomain_hostname_key" ON "WhiteLabelDomain"("hostname");

-- CreateIndex
CREATE UNIQUE INDEX "WhiteLabelDomain_verifyToken_key" ON "WhiteLabelDomain"("verifyToken");

-- CreateIndex
CREATE INDEX "WhiteLabelDomain_configId_idx" ON "WhiteLabelDomain"("configId");

-- CreateIndex
CREATE INDEX "WhiteLabelDomain_status_idx" ON "WhiteLabelDomain"("status");

-- CreateIndex
CREATE INDEX "WhiteLabelDomain_hostname_idx" ON "WhiteLabelDomain"("hostname");

-- CreateIndex
CREATE INDEX "WhiteLabelAudit_configId_idx" ON "WhiteLabelAudit"("configId");

-- CreateIndex
CREATE INDEX "WhiteLabelAudit_createdAt_idx" ON "WhiteLabelAudit"("createdAt");

-- CreateIndex
CREATE INDEX "WhiteLabelAudit_action_idx" ON "WhiteLabelAudit"("action");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformAdmin_userId_key" ON "PlatformAdmin"("userId");

-- CreateIndex
CREATE INDEX "PlatformAdmin_role_idx" ON "PlatformAdmin"("role");

-- CreateIndex
CREATE INDEX "PlatformAdmin_isActive_idx" ON "PlatformAdmin"("isActive");

-- CreateIndex
CREATE INDEX "WhiteLabelAsset_configId_type_idx" ON "WhiteLabelAsset"("configId", "type");

-- CreateIndex
CREATE INDEX "WhiteLabelAsset_type_idx" ON "WhiteLabelAsset"("type");

-- CreateIndex
CREATE INDEX "WhiteLabelAsset_isActive_idx" ON "WhiteLabelAsset"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "ColorPaletteTemplate_slug_key" ON "ColorPaletteTemplate"("slug");

-- CreateIndex
CREATE INDEX "ColorPaletteTemplate_isSystem_idx" ON "ColorPaletteTemplate"("isSystem");

-- CreateIndex
CREATE INDEX "ColorPaletteTemplate_category_idx" ON "ColorPaletteTemplate"("category");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationLimits_clubId_key" ON "OrganizationLimits"("clubId");

-- CreateIndex
CREATE INDEX "OrganizationLimits_clubId_idx" ON "OrganizationLimits"("clubId");

-- CreateIndex
CREATE INDEX "SubscriptionOverride_clubId_idx" ON "SubscriptionOverride"("clubId");

-- CreateIndex
CREATE INDEX "SubscriptionOverride_isActive_idx" ON "SubscriptionOverride"("isActive");

-- CreateIndex
CREATE INDEX "SubscriptionOverride_expiresAt_idx" ON "SubscriptionOverride"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "FeatureFlag_key_key" ON "FeatureFlag"("key");

-- CreateIndex
CREATE UNIQUE INDEX "ImpersonationSession_tokenHash_key" ON "ImpersonationSession"("tokenHash");

-- CreateIndex
CREATE INDEX "ImpersonationSession_adminId_idx" ON "ImpersonationSession"("adminId");

-- CreateIndex
CREATE INDEX "ImpersonationSession_targetUserId_idx" ON "ImpersonationSession"("targetUserId");

-- CreateIndex
CREATE INDEX "ImpersonationSession_targetClubId_idx" ON "ImpersonationSession"("targetClubId");

-- CreateIndex
CREATE INDEX "ImpersonationSession_expiresAt_idx" ON "ImpersonationSession"("expiresAt");

-- CreateIndex
CREATE INDEX "ImpersonationSession_status_idx" ON "ImpersonationSession"("status");

-- CreateIndex
CREATE INDEX "PlatformAuditLog_adminId_idx" ON "PlatformAuditLog"("adminId");

-- CreateIndex
CREATE INDEX "PlatformAuditLog_clubId_idx" ON "PlatformAuditLog"("clubId");

-- CreateIndex
CREATE INDEX "PlatformAuditLog_action_idx" ON "PlatformAuditLog"("action");

-- CreateIndex
CREATE INDEX "PlatformAuditLog_category_idx" ON "PlatformAuditLog"("category");

-- CreateIndex
CREATE INDEX "PlatformAuditLog_result_idx" ON "PlatformAuditLog"("result");

-- CreateIndex
CREATE INDEX "PlatformAuditLog_createdAt_idx" ON "PlatformAuditLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Territory_fullPath_key" ON "Territory"("fullPath");

-- CreateIndex
CREATE INDEX "Territory_parentId_idx" ON "Territory"("parentId");

-- CreateIndex
CREATE INDEX "Territory_type_idx" ON "Territory"("type");

-- CreateIndex
CREATE INDEX "Territory_code_idx" ON "Territory"("code");

-- CreateIndex
CREATE UNIQUE INDEX "FranchiseUnit_code_key" ON "FranchiseUnit"("code");

-- CreateIndex
CREATE INDEX "FranchiseUnit_level_idx" ON "FranchiseUnit"("level");

-- CreateIndex
CREATE INDEX "FranchiseUnit_status_idx" ON "FranchiseUnit"("status");

-- CreateIndex
CREATE INDEX "FranchiseUnit_territoryId_idx" ON "FranchiseUnit"("territoryId");

-- CreateIndex
CREATE INDEX "FranchiseUnit_parentUnitId_idx" ON "FranchiseUnit"("parentUnitId");

-- CreateIndex
CREATE INDEX "FranchiseUnit_code_idx" ON "FranchiseUnit"("code");

-- CreateIndex
CREATE UNIQUE INDEX "FranchiseOwner_userId_key" ON "FranchiseOwner"("userId");

-- CreateIndex
CREATE INDEX "FranchiseOwner_type_idx" ON "FranchiseOwner"("type");

-- CreateIndex
CREATE INDEX "FranchiseOwner_isActive_idx" ON "FranchiseOwner"("isActive");

-- CreateIndex
CREATE INDEX "FranchiseOwner_countryCode_idx" ON "FranchiseOwner"("countryCode");

-- CreateIndex
CREATE UNIQUE INDEX "FranchiseOwnership_transferInId_key" ON "FranchiseOwnership"("transferInId");

-- CreateIndex
CREATE INDEX "FranchiseOwnership_unitId_effectiveTo_idx" ON "FranchiseOwnership"("unitId", "effectiveTo");

-- CreateIndex
CREATE INDEX "FranchiseOwnership_ownerId_idx" ON "FranchiseOwnership"("ownerId");

-- CreateIndex
CREATE INDEX "FranchiseOwnership_isPrimary_idx" ON "FranchiseOwnership"("isPrimary");

-- CreateIndex
CREATE INDEX "FranchiseOwnershipTransfer_unitId_idx" ON "FranchiseOwnershipTransfer"("unitId");

-- CreateIndex
CREATE INDEX "FranchiseOwnershipTransfer_fromOwnerId_idx" ON "FranchiseOwnershipTransfer"("fromOwnerId");

-- CreateIndex
CREATE INDEX "FranchiseOwnershipTransfer_toOwnerId_idx" ON "FranchiseOwnershipTransfer"("toOwnerId");

-- CreateIndex
CREATE INDEX "FranchiseOwnershipTransfer_status_idx" ON "FranchiseOwnershipTransfer"("status");

-- CreateIndex
CREATE INDEX "TerritoryRight_unitId_idx" ON "TerritoryRight"("unitId");

-- CreateIndex
CREATE INDEX "TerritoryRight_territoryId_idx" ON "TerritoryRight"("territoryId");

-- CreateIndex
CREATE INDEX "TerritoryRight_type_isActive_idx" ON "TerritoryRight"("type", "isActive");

-- CreateIndex
CREATE INDEX "TerritoryRight_level_idx" ON "TerritoryRight"("level");

-- CreateIndex
CREATE INDEX "ExpansionRequest_requestingUnitId_idx" ON "ExpansionRequest"("requestingUnitId");

-- CreateIndex
CREATE INDEX "ExpansionRequest_targetTerritoryId_idx" ON "ExpansionRequest"("targetTerritoryId");

-- CreateIndex
CREATE INDEX "ExpansionRequest_status_idx" ON "ExpansionRequest"("status");

-- CreateIndex
CREATE INDEX "FranchiseAcquisitionRequest_targetUnitId_idx" ON "FranchiseAcquisitionRequest"("targetUnitId");

-- CreateIndex
CREATE INDEX "FranchiseAcquisitionRequest_status_idx" ON "FranchiseAcquisitionRequest"("status");

-- CreateIndex
CREATE INDEX "FranchiseAcquisitionRequest_acquirerOwnerId_idx" ON "FranchiseAcquisitionRequest"("acquirerOwnerId");

-- CreateIndex
CREATE INDEX "RevenueSplitRule_unitId_idx" ON "RevenueSplitRule"("unitId");

-- CreateIndex
CREATE INDEX "RevenueSplitRule_category_idx" ON "RevenueSplitRule"("category");

-- CreateIndex
CREATE INDEX "RevenueSplitRule_priority_idx" ON "RevenueSplitRule"("priority");

-- CreateIndex
CREATE INDEX "RevenueSplitRule_isActive_idx" ON "RevenueSplitRule"("isActive");

-- CreateIndex
CREATE INDEX "RevenueSplitRecipient_ruleId_idx" ON "RevenueSplitRecipient"("ruleId");

-- CreateIndex
CREATE INDEX "RevenueSplitRecipient_recipientUnitId_idx" ON "RevenueSplitRecipient"("recipientUnitId");

-- CreateIndex
CREATE INDEX "RevenueSplitRecipient_recipientOwnerId_idx" ON "RevenueSplitRecipient"("recipientOwnerId");

-- CreateIndex
CREATE INDEX "RevenueDistribution_unitId_idx" ON "RevenueDistribution"("unitId");

-- CreateIndex
CREATE INDEX "RevenueDistribution_clubId_idx" ON "RevenueDistribution"("clubId");

-- CreateIndex
CREATE INDEX "RevenueDistribution_status_idx" ON "RevenueDistribution"("status");

-- CreateIndex
CREATE INDEX "RevenueDistribution_computedAt_idx" ON "RevenueDistribution"("computedAt");

-- CreateIndex
CREATE INDEX "RevenueDistribution_sourceRef_idx" ON "RevenueDistribution"("sourceRef");

-- CreateIndex
CREATE INDEX "RevenueDistributionAllocation_distributionId_idx" ON "RevenueDistributionAllocation"("distributionId");

-- CreateIndex
CREATE INDEX "RevenueDistributionAllocation_recipientUnitId_idx" ON "RevenueDistributionAllocation"("recipientUnitId");

-- CreateIndex
CREATE INDEX "RevenueDistributionAllocation_recipientOwnerId_idx" ON "RevenueDistributionAllocation"("recipientOwnerId");

-- CreateIndex
CREATE INDEX "RevenueDistributionAllocation_status_idx" ON "RevenueDistributionAllocation"("status");

-- CreateIndex
CREATE INDEX "FranchiseContract_unitId_idx" ON "FranchiseContract"("unitId");

-- CreateIndex
CREATE INDEX "FranchiseContract_type_idx" ON "FranchiseContract"("type");

-- CreateIndex
CREATE INDEX "FranchiseContract_status_idx" ON "FranchiseContract"("status");

-- CreateIndex
CREATE INDEX "FranchiseContract_effectiveTo_idx" ON "FranchiseContract"("effectiveTo");

-- CreateIndex
CREATE INDEX "FranchiseContractRenewal_contractId_idx" ON "FranchiseContractRenewal"("contractId");

-- CreateIndex
CREATE INDEX "FranchiseContractRenewal_status_idx" ON "FranchiseContractRenewal"("status");

-- CreateIndex
CREATE INDEX "FranchiseContractTermination_contractId_idx" ON "FranchiseContractTermination"("contractId");

-- CreateIndex
CREATE INDEX "FranchiseContractTermination_status_idx" ON "FranchiseContractTermination"("status");

-- CreateIndex
CREATE INDEX "FranchiseViolation_unitId_idx" ON "FranchiseViolation"("unitId");

-- CreateIndex
CREATE INDEX "FranchiseViolation_status_idx" ON "FranchiseViolation"("status");

-- CreateIndex
CREATE INDEX "FranchiseViolation_severity_idx" ON "FranchiseViolation"("severity");

-- CreateIndex
CREATE INDEX "FranchiseViolation_dueByAt_idx" ON "FranchiseViolation"("dueByAt");

-- CreateIndex
CREATE INDEX "ComplianceCheck_unitId_idx" ON "ComplianceCheck"("unitId");

-- CreateIndex
CREATE INDEX "ComplianceCheck_category_idx" ON "ComplianceCheck"("category");

-- CreateIndex
CREATE INDEX "ComplianceCheck_period_idx" ON "ComplianceCheck"("period");

-- CreateIndex
CREATE INDEX "ComplianceCheck_status_idx" ON "ComplianceCheck"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ComplianceCheck_unitId_category_period_key" ON "ComplianceCheck"("unitId", "category", "period");

-- CreateIndex
CREATE INDEX "FranchisePerformanceSnapshot_unitId_idx" ON "FranchisePerformanceSnapshot"("unitId");

-- CreateIndex
CREATE INDEX "FranchisePerformanceSnapshot_period_idx" ON "FranchisePerformanceSnapshot"("period");

-- CreateIndex
CREATE UNIQUE INDEX "FranchisePerformanceSnapshot_unitId_period_key" ON "FranchisePerformanceSnapshot"("unitId", "period");

-- CreateIndex
CREATE INDEX "FranchiseAudit_unitId_idx" ON "FranchiseAudit"("unitId");

-- CreateIndex
CREATE INDEX "FranchiseAudit_userId_idx" ON "FranchiseAudit"("userId");

-- CreateIndex
CREATE INDEX "FranchiseAudit_action_idx" ON "FranchiseAudit"("action");

-- CreateIndex
CREATE INDEX "FranchiseAudit_category_idx" ON "FranchiseAudit"("category");

-- CreateIndex
CREATE INDEX "FranchiseAudit_createdAt_idx" ON "FranchiseAudit"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "InvestorProfile_userId_key" ON "InvestorProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "InvestorProfile_linkedFranchiseOwnerId_key" ON "InvestorProfile"("linkedFranchiseOwnerId");

-- CreateIndex
CREATE INDEX "InvestorProfile_type_idx" ON "InvestorProfile"("type");

-- CreateIndex
CREATE INDEX "InvestorProfile_kycStatus_idx" ON "InvestorProfile"("kycStatus");

-- CreateIndex
CREATE INDEX "InvestorProfile_isActive_idx" ON "InvestorProfile"("isActive");

-- CreateIndex
CREATE INDEX "InvestorProfile_countryCode_idx" ON "InvestorProfile"("countryCode");

-- CreateIndex
CREATE UNIQUE INDEX "InvestmentEntity_code_key" ON "InvestmentEntity"("code");

-- CreateIndex
CREATE UNIQUE INDEX "InvestmentEntity_franchiseUnitId_key" ON "InvestmentEntity"("franchiseUnitId");

-- CreateIndex
CREATE UNIQUE INDEX "InvestmentEntity_clubId_key" ON "InvestmentEntity"("clubId");

-- CreateIndex
CREATE INDEX "InvestmentEntity_type_idx" ON "InvestmentEntity"("type");

-- CreateIndex
CREATE INDEX "InvestmentEntity_isActive_idx" ON "InvestmentEntity"("isActive");

-- CreateIndex
CREATE INDEX "ShareClass_entityId_idx" ON "ShareClass"("entityId");

-- CreateIndex
CREATE INDEX "ShareClass_seniority_idx" ON "ShareClass"("seniority");

-- CreateIndex
CREATE UNIQUE INDEX "ShareClass_entityId_code_key" ON "ShareClass"("entityId", "code");

-- CreateIndex
CREATE INDEX "InvestmentRound_entityId_idx" ON "InvestmentRound"("entityId");

-- CreateIndex
CREATE INDEX "InvestmentRound_status_idx" ON "InvestmentRound"("status");

-- CreateIndex
CREATE INDEX "InvestmentRound_type_idx" ON "InvestmentRound"("type");

-- CreateIndex
CREATE UNIQUE INDEX "Investment_convertedToInvestmentId_key" ON "Investment"("convertedToInvestmentId");

-- CreateIndex
CREATE INDEX "Investment_investorId_idx" ON "Investment"("investorId");

-- CreateIndex
CREATE INDEX "Investment_entityId_idx" ON "Investment"("entityId");

-- CreateIndex
CREATE INDEX "Investment_roundId_idx" ON "Investment"("roundId");

-- CreateIndex
CREATE INDEX "Investment_instrumentType_idx" ON "Investment"("instrumentType");

-- CreateIndex
CREATE INDEX "Investment_status_idx" ON "Investment"("status");

-- CreateIndex
CREATE INDEX "Investment_linkedFranchiseUnitId_idx" ON "Investment"("linkedFranchiseUnitId");

-- CreateIndex
CREATE INDEX "Investment_linkedClubId_idx" ON "Investment"("linkedClubId");

-- CreateIndex
CREATE UNIQUE INDEX "CapTableEntry_transferInId_key" ON "CapTableEntry"("transferInId");

-- CreateIndex
CREATE INDEX "CapTableEntry_entityId_effectiveTo_idx" ON "CapTableEntry"("entityId", "effectiveTo");

-- CreateIndex
CREATE INDEX "CapTableEntry_investorId_idx" ON "CapTableEntry"("investorId");

-- CreateIndex
CREATE INDEX "CapTableEntry_shareClassId_idx" ON "CapTableEntry"("shareClassId");

-- CreateIndex
CREATE INDEX "ShareTransfer_entityId_idx" ON "ShareTransfer"("entityId");

-- CreateIndex
CREATE INDEX "ShareTransfer_fromInvestorId_idx" ON "ShareTransfer"("fromInvestorId");

-- CreateIndex
CREATE INDEX "ShareTransfer_toInvestorId_idx" ON "ShareTransfer"("toInvestorId");

-- CreateIndex
CREATE INDEX "ShareTransfer_status_idx" ON "ShareTransfer"("status");

-- CreateIndex
CREATE INDEX "InvestorRight_investorId_idx" ON "InvestorRight"("investorId");

-- CreateIndex
CREATE INDEX "InvestorRight_entityId_idx" ON "InvestorRight"("entityId");

-- CreateIndex
CREATE INDEX "InvestorRight_type_idx" ON "InvestorRight"("type");

-- CreateIndex
CREATE INDEX "InvestorRight_isActive_idx" ON "InvestorRight"("isActive");

-- CreateIndex
CREATE INDEX "BoardSeat_entityId_idx" ON "BoardSeat"("entityId");

-- CreateIndex
CREATE INDEX "BoardSeat_investorId_idx" ON "BoardSeat"("investorId");

-- CreateIndex
CREATE INDEX "BoardSeat_isActive_idx" ON "BoardSeat"("isActive");

-- CreateIndex
CREATE INDEX "InvestmentAgreement_entityId_idx" ON "InvestmentAgreement"("entityId");

-- CreateIndex
CREATE INDEX "InvestmentAgreement_investmentId_idx" ON "InvestmentAgreement"("investmentId");

-- CreateIndex
CREATE INDEX "InvestmentAgreement_investorId_idx" ON "InvestmentAgreement"("investorId");

-- CreateIndex
CREATE INDEX "InvestmentAgreement_type_idx" ON "InvestmentAgreement"("type");

-- CreateIndex
CREATE INDEX "InvestmentAgreement_status_idx" ON "InvestmentAgreement"("status");

-- CreateIndex
CREATE INDEX "ExitEvent_entityId_idx" ON "ExitEvent"("entityId");

-- CreateIndex
CREATE INDEX "ExitEvent_status_idx" ON "ExitEvent"("status");

-- CreateIndex
CREATE INDEX "ExitEvent_type_idx" ON "ExitEvent"("type");

-- CreateIndex
CREATE INDEX "ExitDistribution_exitId_idx" ON "ExitDistribution"("exitId");

-- CreateIndex
CREATE INDEX "ExitDistribution_investorId_idx" ON "ExitDistribution"("investorId");

-- CreateIndex
CREATE INDEX "ExitDistribution_status_idx" ON "ExitDistribution"("status");

-- CreateIndex
CREATE INDEX "InvestorDistribution_investorId_idx" ON "InvestorDistribution"("investorId");

-- CreateIndex
CREATE INDEX "InvestorDistribution_investmentId_idx" ON "InvestorDistribution"("investmentId");

-- CreateIndex
CREATE INDEX "InvestorDistribution_type_idx" ON "InvestorDistribution"("type");

-- CreateIndex
CREATE INDEX "InvestorDistribution_status_idx" ON "InvestorDistribution"("status");

-- CreateIndex
CREATE INDEX "InvestorDistribution_period_idx" ON "InvestorDistribution"("period");

-- CreateIndex
CREATE INDEX "InvestorDistribution_sourceRef_idx" ON "InvestorDistribution"("sourceRef");

-- CreateIndex
CREATE INDEX "InvestorAudit_investorId_idx" ON "InvestorAudit"("investorId");

-- CreateIndex
CREATE INDEX "InvestorAudit_entityId_idx" ON "InvestorAudit"("entityId");

-- CreateIndex
CREATE INDEX "InvestorAudit_action_idx" ON "InvestorAudit"("action");

-- CreateIndex
CREATE INDEX "InvestorAudit_category_idx" ON "InvestorAudit"("category");

-- CreateIndex
CREATE INDEX "InvestorAudit_createdAt_idx" ON "InvestorAudit"("createdAt");

-- CreateIndex
CREATE INDEX "AIModel_domain_decisionType_isActive_idx" ON "AIModel"("domain", "decisionType", "isActive");

-- CreateIndex
CREATE INDEX "AIModel_slug_idx" ON "AIModel"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "AIModel_slug_version_key" ON "AIModel"("slug", "version");

-- CreateIndex
CREATE INDEX "AIDecision_domain_decisionType_idx" ON "AIDecision"("domain", "decisionType");

-- CreateIndex
CREATE INDEX "AIDecision_subjectType_subjectId_idx" ON "AIDecision"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "AIDecision_clubId_idx" ON "AIDecision"("clubId");

-- CreateIndex
CREATE INDEX "AIDecision_franchiseUnitId_idx" ON "AIDecision"("franchiseUnitId");

-- CreateIndex
CREATE INDEX "AIDecision_investorId_idx" ON "AIDecision"("investorId");

-- CreateIndex
CREATE INDEX "AIDecision_entityId_idx" ON "AIDecision"("entityId");

-- CreateIndex
CREATE INDEX "AIDecision_status_idx" ON "AIDecision"("status");

-- CreateIndex
CREATE INDEX "AIDecision_outcome_idx" ON "AIDecision"("outcome");

-- CreateIndex
CREATE INDEX "AIDecision_urgency_idx" ON "AIDecision"("urgency");

-- CreateIndex
CREATE INDEX "AIDecision_createdAt_idx" ON "AIDecision"("createdAt");

-- CreateIndex
CREATE INDEX "AIDecision_inputHash_idx" ON "AIDecision"("inputHash");

-- CreateIndex
CREATE INDEX "AIDecisionFeedback_decisionId_idx" ON "AIDecisionFeedback"("decisionId");

-- CreateIndex
CREATE INDEX "AIDecisionFeedback_type_idx" ON "AIDecisionFeedback"("type");

-- CreateIndex
CREATE INDEX "AIAudit_decisionId_idx" ON "AIAudit"("decisionId");

-- CreateIndex
CREATE INDEX "AIAudit_modelId_idx" ON "AIAudit"("modelId");

-- CreateIndex
CREATE INDEX "AIAudit_action_idx" ON "AIAudit"("action");

-- CreateIndex
CREATE INDEX "AIAudit_category_idx" ON "AIAudit"("category");

-- CreateIndex
CREATE INDEX "AIAudit_createdAt_idx" ON "AIAudit"("createdAt");

-- CreateIndex
CREATE INDEX "VideoAsset_clubId_idx" ON "VideoAsset"("clubId");

-- CreateIndex
CREATE INDEX "VideoAsset_matchId_idx" ON "VideoAsset"("matchId");

-- CreateIndex
CREATE INDEX "VideoAsset_trainingSessionId_idx" ON "VideoAsset"("trainingSessionId");

-- CreateIndex
CREATE INDEX "VideoAsset_source_idx" ON "VideoAsset"("source");

-- CreateIndex
CREATE INDEX "VideoIngestJob_videoAssetId_idx" ON "VideoIngestJob"("videoAssetId");

-- CreateIndex
CREATE INDEX "VideoIngestJob_stage_idx" ON "VideoIngestJob"("stage");

-- CreateIndex
CREATE INDEX "VideoIngestJob_status_idx" ON "VideoIngestJob"("status");

-- CreateIndex
CREATE INDEX "VideoIngestJob_externalJobId_idx" ON "VideoIngestJob"("externalJobId");

-- CreateIndex
CREATE INDEX "VisionAnalysisRun_videoAssetId_idx" ON "VisionAnalysisRun"("videoAssetId");

-- CreateIndex
CREATE INDEX "VisionAnalysisRun_matchId_idx" ON "VisionAnalysisRun"("matchId");

-- CreateIndex
CREATE INDEX "VisionAnalysisRun_clubId_idx" ON "VisionAnalysisRun"("clubId");

-- CreateIndex
CREATE INDEX "VisionAnalysisRun_status_idx" ON "VisionAnalysisRun"("status");

-- CreateIndex
CREATE INDEX "PlayerTrack_analysisId_playerId_idx" ON "PlayerTrack"("analysisId", "playerId");

-- CreateIndex
CREATE INDEX "PlayerTrack_analysisId_teamSide_idx" ON "PlayerTrack"("analysisId", "teamSide");

-- CreateIndex
CREATE INDEX "PlayerTrack_startMs_idx" ON "PlayerTrack"("startMs");

-- CreateIndex
CREATE INDEX "BallTrack_analysisId_idx" ON "BallTrack"("analysisId");

-- CreateIndex
CREATE INDEX "MatchEvent_analysisId_type_idx" ON "MatchEvent"("analysisId", "type");

-- CreateIndex
CREATE INDEX "MatchEvent_matchId_occurredAtMs_idx" ON "MatchEvent"("matchId", "occurredAtMs");

-- CreateIndex
CREATE INDEX "MatchEvent_primaryPlayerId_idx" ON "MatchEvent"("primaryPlayerId");

-- CreateIndex
CREATE INDEX "MatchEvent_secondaryPlayerId_idx" ON "MatchEvent"("secondaryPlayerId");

-- CreateIndex
CREATE INDEX "AnalyticsResult_analysisId_kind_idx" ON "AnalyticsResult"("analysisId", "kind");

-- CreateIndex
CREATE INDEX "AnalyticsResult_matchId_kind_idx" ON "AnalyticsResult"("matchId", "kind");

-- CreateIndex
CREATE INDEX "AnalyticsResult_playerId_idx" ON "AnalyticsResult"("playerId");

-- CreateIndex
CREATE INDEX "AnalyticsResult_trainingSessionId_idx" ON "AnalyticsResult"("trainingSessionId");

-- CreateIndex
CREATE INDEX "FusedPlayerSample_matchId_playerId_idx" ON "FusedPlayerSample"("matchId", "playerId");

-- CreateIndex
CREATE INDEX "FusedPlayerSample_trainingSessionId_playerId_idx" ON "FusedPlayerSample"("trainingSessionId", "playerId");

-- CreateIndex
CREATE INDEX "FusedPlayerSample_playerId_windowStartMs_idx" ON "FusedPlayerSample"("playerId", "windowStartMs");

-- CreateIndex
CREATE INDEX "Clip_videoAssetId_idx" ON "Clip"("videoAssetId");

-- CreateIndex
CREATE INDEX "Clip_matchId_idx" ON "Clip"("matchId");

-- CreateIndex
CREATE INDEX "Clip_playerId_idx" ON "Clip"("playerId");

-- CreateIndex
CREATE INDEX "Clip_purpose_idx" ON "Clip"("purpose");

-- CreateIndex
CREATE INDEX "Clip_status_idx" ON "Clip"("status");

-- CreateIndex
CREATE UNIQUE INDEX "LiveMatchStream_matchId_key" ON "LiveMatchStream"("matchId");

-- CreateIndex
CREATE INDEX "LiveMatchStream_status_idx" ON "LiveMatchStream"("status");

-- CreateIndex
CREATE INDEX "LiveEvent_streamId_occurredAtMs_idx" ON "LiveEvent"("streamId", "occurredAtMs");

-- CreateIndex
CREATE INDEX "LiveEvent_matchId_idx" ON "LiveEvent"("matchId");

-- CreateIndex
CREATE INDEX "LiveEvent_type_idx" ON "LiveEvent"("type");

-- CreateIndex
CREATE INDEX "ScoutingReport_matchId_idx" ON "ScoutingReport"("matchId");

-- CreateIndex
CREATE INDEX "ScoutingReport_targetPlayerId_idx" ON "ScoutingReport"("targetPlayerId");

-- CreateIndex
CREATE INDEX "ScoutingReport_kind_idx" ON "ScoutingReport"("kind");

-- CreateIndex
CREATE INDEX "VisionAudit_analysisId_idx" ON "VisionAudit"("analysisId");

-- CreateIndex
CREATE INDEX "VisionAudit_matchId_idx" ON "VisionAudit"("matchId");

-- CreateIndex
CREATE INDEX "VisionAudit_action_idx" ON "VisionAudit"("action");

-- CreateIndex
CREATE INDEX "VisionAudit_category_idx" ON "VisionAudit"("category");

-- CreateIndex
CREATE INDEX "VisionAudit_createdAt_idx" ON "VisionAudit"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutiveAssignment_userId_key" ON "ExecutiveAssignment"("userId");

-- CreateIndex
CREATE INDEX "ExecutiveAssignment_role_idx" ON "ExecutiveAssignment"("role");

-- CreateIndex
CREATE INDEX "ExecutiveAssignment_isActive_idx" ON "ExecutiveAssignment"("isActive");

-- CreateIndex
CREATE INDEX "ExecutiveWorkflow_kind_idx" ON "ExecutiveWorkflow"("kind");

-- CreateIndex
CREATE INDEX "ExecutiveWorkflow_status_idx" ON "ExecutiveWorkflow"("status");

-- CreateIndex
CREATE INDEX "ExecutiveWorkflow_priority_idx" ON "ExecutiveWorkflow"("priority");

-- CreateIndex
CREATE INDEX "ExecutiveWorkflow_clubId_idx" ON "ExecutiveWorkflow"("clubId");

-- CreateIndex
CREATE INDEX "ExecutiveWorkflow_franchiseUnitId_idx" ON "ExecutiveWorkflow"("franchiseUnitId");

-- CreateIndex
CREATE INDEX "ExecutiveWorkflow_investorId_idx" ON "ExecutiveWorkflow"("investorId");

-- CreateIndex
CREATE INDEX "ExecutiveWorkflow_entityId_idx" ON "ExecutiveWorkflow"("entityId");

-- CreateIndex
CREATE INDEX "ExecutiveWorkflow_dueByAt_idx" ON "ExecutiveWorkflow"("dueByAt");

-- CreateIndex
CREATE INDEX "WorkflowStep_status_idx" ON "WorkflowStep"("status");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowStep_workflowId_order_key" ON "WorkflowStep"("workflowId", "order");

-- CreateIndex
CREATE INDEX "WorkflowAttestation_workflowId_idx" ON "WorkflowAttestation"("workflowId");

-- CreateIndex
CREATE INDEX "WorkflowAttestation_role_idx" ON "WorkflowAttestation"("role");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowAttestation_workflowId_attesterUserId_key" ON "WorkflowAttestation"("workflowId", "attesterUserId");

-- CreateIndex
CREATE INDEX "BoardResolution_status_idx" ON "BoardResolution"("status");

-- CreateIndex
CREATE INDEX "BoardResolution_votingClosesAt_idx" ON "BoardResolution"("votingClosesAt");

-- CreateIndex
CREATE INDEX "BoardVote_resolutionId_idx" ON "BoardVote"("resolutionId");

-- CreateIndex
CREATE UNIQUE INDEX "BoardVote_resolutionId_voterUserId_key" ON "BoardVote"("resolutionId", "voterUserId");

-- CreateIndex
CREATE INDEX "SponsorOpportunity_stage_idx" ON "SponsorOpportunity"("stage");

-- CreateIndex
CREATE INDEX "SponsorOpportunity_tier_idx" ON "SponsorOpportunity"("tier");

-- CreateIndex
CREATE INDEX "SponsorOpportunity_clubId_idx" ON "SponsorOpportunity"("clubId");

-- CreateIndex
CREATE INDEX "SponsorOpportunity_franchiseUnitId_idx" ON "SponsorOpportunity"("franchiseUnitId");

-- CreateIndex
CREATE INDEX "SponsorOpportunity_ownedBy_idx" ON "SponsorOpportunity"("ownedBy");

-- CreateIndex
CREATE INDEX "SponsorPipelineEvent_opportunityId_idx" ON "SponsorPipelineEvent"("opportunityId");

-- CreateIndex
CREATE INDEX "RevenueForecast_scope_scopeId_idx" ON "RevenueForecast"("scope", "scopeId");

-- CreateIndex
CREATE INDEX "RevenueForecast_periodKey_idx" ON "RevenueForecast"("periodKey");

-- CreateIndex
CREATE INDEX "RevenueForecast_scenario_idx" ON "RevenueForecast"("scenario");

-- CreateIndex
CREATE UNIQUE INDEX "RevenueForecast_scope_scopeId_periodKey_scenario_modelVersi_key" ON "RevenueForecast"("scope", "scopeId", "periodKey", "scenario", "modelVersion");

-- CreateIndex
CREATE UNIQUE INDEX "RiskAlert_fingerprint_key" ON "RiskAlert"("fingerprint");

-- CreateIndex
CREATE INDEX "RiskAlert_status_severity_idx" ON "RiskAlert"("status", "severity");

-- CreateIndex
CREATE INDEX "RiskAlert_category_idx" ON "RiskAlert"("category");

-- CreateIndex
CREATE INDEX "RiskAlert_clubId_idx" ON "RiskAlert"("clubId");

-- CreateIndex
CREATE INDEX "RiskAlert_franchiseUnitId_idx" ON "RiskAlert"("franchiseUnitId");

-- CreateIndex
CREATE INDEX "RiskAlert_investorId_idx" ON "RiskAlert"("investorId");

-- CreateIndex
CREATE INDEX "RiskAlert_entityId_idx" ON "RiskAlert"("entityId");

-- CreateIndex
CREATE INDEX "ExecutiveAudit_workflowId_idx" ON "ExecutiveAudit"("workflowId");

-- CreateIndex
CREATE INDEX "ExecutiveAudit_resolutionId_idx" ON "ExecutiveAudit"("resolutionId");

-- CreateIndex
CREATE INDEX "ExecutiveAudit_action_idx" ON "ExecutiveAudit"("action");

-- CreateIndex
CREATE INDEX "ExecutiveAudit_category_idx" ON "ExecutiveAudit"("category");

-- CreateIndex
CREATE INDEX "ExecutiveAudit_createdAt_idx" ON "ExecutiveAudit"("createdAt");

-- AddForeignKey
ALTER TABLE "Club" ADD CONSTRAINT "Club_franchiseUnitId_fkey" FOREIGN KEY ("franchiseUnitId") REFERENCES "FranchiseUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_currentClubId_fkey" FOREIGN KEY ("currentClubId") REFERENCES "Club"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_currentTeamId_fkey" FOREIGN KEY ("currentTeamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Player" ADD CONSTRAINT "Player_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Player" ADD CONSTRAINT "Player_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerAuditLog" ADD CONSTRAINT "PlayerAuditLog_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipAuditLog" ADD CONSTRAINT "MembershipAuditLog_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "Membership"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipAuditLog" ADD CONSTRAINT "MembershipAuditLog_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipAuditLog" ADD CONSTRAINT "MembershipAuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerAttribute" ADD CONSTRAINT "PlayerAttribute_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerGpsData" ADD CONSTRAINT "PlayerGpsData_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerInjury" ADD CONSTRAINT "PlayerInjury_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_deviceSessionId_fkey" FOREIGN KEY ("deviceSessionId") REFERENCES "DeviceSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerMatchStat" ADD CONSTRAINT "PlayerMatchStat_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerMatchStat" ADD CONSTRAINT "PlayerMatchStat_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchLineup" ADD CONSTRAINT "MatchLineup_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchTimeline" ADD CONSTRAINT "MatchTimeline_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchTacticalSnapshot" ADD CONSTRAINT "MatchTacticalSnapshot_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchAuditLog" ADD CONSTRAINT "MatchAuditLog_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SensorPacket" ADD CONSTRAINT "SensorPacket_deviceSessionId_fkey" FOREIGN KEY ("deviceSessionId") REFERENCES "DeviceSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "AutomationTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tournament" ADD CONSTRAINT "Tournament_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingSession" ADD CONSTRAINT "TrainingSession_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerTrainingStat" ADD CONSTRAINT "PlayerTrainingStat_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "TrainingSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerTrainingStat" ADD CONSTRAINT "PlayerTrainingStat_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GpsDevice" ADD CONSTRAINT "GpsDevice_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GpsDevice" ADD CONSTRAINT "GpsDevice_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScoutReport" ADD CONSTRAINT "ScoutReport_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Financial" ADD CONSTRAINT "Financial_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiInsight" ADD CONSTRAINT "AiInsight_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiInsight" ADD CONSTRAINT "AiInsight_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhiteLabelConfig" ADD CONSTRAINT "WhiteLabelConfig_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhiteLabelDomain" ADD CONSTRAINT "WhiteLabelDomain_configId_fkey" FOREIGN KEY ("configId") REFERENCES "WhiteLabelConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhiteLabelAudit" ADD CONSTRAINT "WhiteLabelAudit_configId_fkey" FOREIGN KEY ("configId") REFERENCES "WhiteLabelConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformAdmin" ADD CONSTRAINT "PlatformAdmin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhiteLabelAsset" ADD CONSTRAINT "WhiteLabelAsset_configId_fkey" FOREIGN KEY ("configId") REFERENCES "WhiteLabelConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationLimits" ADD CONSTRAINT "OrganizationLimits_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionOverride" ADD CONSTRAINT "SubscriptionOverride_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImpersonationSession" ADD CONSTRAINT "ImpersonationSession_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "PlatformAdmin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImpersonationSession" ADD CONSTRAINT "ImpersonationSession_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformAuditLog" ADD CONSTRAINT "PlatformAuditLog_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "PlatformAdmin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlatformAuditLog" ADD CONSTRAINT "PlatformAuditLog_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Territory" ADD CONSTRAINT "Territory_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Territory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FranchiseUnit" ADD CONSTRAINT "FranchiseUnit_parentUnitId_fkey" FOREIGN KEY ("parentUnitId") REFERENCES "FranchiseUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FranchiseUnit" ADD CONSTRAINT "FranchiseUnit_territoryId_fkey" FOREIGN KEY ("territoryId") REFERENCES "Territory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FranchiseOwner" ADD CONSTRAINT "FranchiseOwner_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FranchiseOwnership" ADD CONSTRAINT "FranchiseOwnership_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "FranchiseUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FranchiseOwnership" ADD CONSTRAINT "FranchiseOwnership_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "FranchiseOwner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FranchiseOwnershipTransfer" ADD CONSTRAINT "FranchiseOwnershipTransfer_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "FranchiseUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FranchiseOwnershipTransfer" ADD CONSTRAINT "FranchiseOwnershipTransfer_fromOwnerId_fkey" FOREIGN KEY ("fromOwnerId") REFERENCES "FranchiseOwner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FranchiseOwnershipTransfer" ADD CONSTRAINT "FranchiseOwnershipTransfer_toOwnerId_fkey" FOREIGN KEY ("toOwnerId") REFERENCES "FranchiseOwner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TerritoryRight" ADD CONSTRAINT "TerritoryRight_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "FranchiseUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TerritoryRight" ADD CONSTRAINT "TerritoryRight_territoryId_fkey" FOREIGN KEY ("territoryId") REFERENCES "Territory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpansionRequest" ADD CONSTRAINT "ExpansionRequest_requestingUnitId_fkey" FOREIGN KEY ("requestingUnitId") REFERENCES "FranchiseUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpansionRequest" ADD CONSTRAINT "ExpansionRequest_targetTerritoryId_fkey" FOREIGN KEY ("targetTerritoryId") REFERENCES "Territory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FranchiseAcquisitionRequest" ADD CONSTRAINT "FranchiseAcquisitionRequest_targetUnitId_fkey" FOREIGN KEY ("targetUnitId") REFERENCES "FranchiseUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FranchiseAcquisitionRequest" ADD CONSTRAINT "FranchiseAcquisitionRequest_acquirerOwnerId_fkey" FOREIGN KEY ("acquirerOwnerId") REFERENCES "FranchiseOwner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevenueSplitRule" ADD CONSTRAINT "RevenueSplitRule_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "FranchiseUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevenueSplitRecipient" ADD CONSTRAINT "RevenueSplitRecipient_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "RevenueSplitRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevenueDistribution" ADD CONSTRAINT "RevenueDistribution_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "FranchiseUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevenueDistribution" ADD CONSTRAINT "RevenueDistribution_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "RevenueSplitRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevenueDistribution" ADD CONSTRAINT "RevenueDistribution_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevenueDistributionAllocation" ADD CONSTRAINT "RevenueDistributionAllocation_distributionId_fkey" FOREIGN KEY ("distributionId") REFERENCES "RevenueDistribution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevenueDistributionAllocation" ADD CONSTRAINT "RevenueDistributionAllocation_recipientOwnerId_fkey" FOREIGN KEY ("recipientOwnerId") REFERENCES "FranchiseOwner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FranchiseContract" ADD CONSTRAINT "FranchiseContract_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "FranchiseUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FranchiseContractRenewal" ADD CONSTRAINT "FranchiseContractRenewal_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "FranchiseContract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FranchiseContractRenewal" ADD CONSTRAINT "FranchiseContractRenewal_renewedToContractId_fkey" FOREIGN KEY ("renewedToContractId") REFERENCES "FranchiseContract"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FranchiseContractTermination" ADD CONSTRAINT "FranchiseContractTermination_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "FranchiseContract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FranchiseViolation" ADD CONSTRAINT "FranchiseViolation_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "FranchiseUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FranchiseViolation" ADD CONSTRAINT "FranchiseViolation_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "FranchiseContract"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceCheck" ADD CONSTRAINT "ComplianceCheck_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "FranchiseUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FranchisePerformanceSnapshot" ADD CONSTRAINT "FranchisePerformanceSnapshot_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "FranchiseUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FranchiseAudit" ADD CONSTRAINT "FranchiseAudit_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "FranchiseUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestorProfile" ADD CONSTRAINT "InvestorProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestmentEntity" ADD CONSTRAINT "InvestmentEntity_franchiseUnitId_fkey" FOREIGN KEY ("franchiseUnitId") REFERENCES "FranchiseUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestmentEntity" ADD CONSTRAINT "InvestmentEntity_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShareClass" ADD CONSTRAINT "ShareClass_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "InvestmentEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestmentRound" ADD CONSTRAINT "InvestmentRound_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "InvestmentEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestmentRound" ADD CONSTRAINT "InvestmentRound_shareClassId_fkey" FOREIGN KEY ("shareClassId") REFERENCES "ShareClass"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Investment" ADD CONSTRAINT "Investment_investorId_fkey" FOREIGN KEY ("investorId") REFERENCES "InvestorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Investment" ADD CONSTRAINT "Investment_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "InvestmentEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Investment" ADD CONSTRAINT "Investment_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "InvestmentRound"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Investment" ADD CONSTRAINT "Investment_shareClassId_fkey" FOREIGN KEY ("shareClassId") REFERENCES "ShareClass"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapTableEntry" ADD CONSTRAINT "CapTableEntry_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "InvestmentEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapTableEntry" ADD CONSTRAINT "CapTableEntry_investorId_fkey" FOREIGN KEY ("investorId") REFERENCES "InvestorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapTableEntry" ADD CONSTRAINT "CapTableEntry_shareClassId_fkey" FOREIGN KEY ("shareClassId") REFERENCES "ShareClass"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapTableEntry" ADD CONSTRAINT "CapTableEntry_originalInvestmentId_fkey" FOREIGN KEY ("originalInvestmentId") REFERENCES "Investment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapTableEntry" ADD CONSTRAINT "CapTableEntry_transferInId_fkey" FOREIGN KEY ("transferInId") REFERENCES "ShareTransfer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShareTransfer" ADD CONSTRAINT "ShareTransfer_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "InvestmentEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShareTransfer" ADD CONSTRAINT "ShareTransfer_fromInvestorId_fkey" FOREIGN KEY ("fromInvestorId") REFERENCES "InvestorProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShareTransfer" ADD CONSTRAINT "ShareTransfer_toInvestorId_fkey" FOREIGN KEY ("toInvestorId") REFERENCES "InvestorProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShareTransfer" ADD CONSTRAINT "ShareTransfer_shareClassId_fkey" FOREIGN KEY ("shareClassId") REFERENCES "ShareClass"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestorRight" ADD CONSTRAINT "InvestorRight_investorId_fkey" FOREIGN KEY ("investorId") REFERENCES "InvestorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestorRight" ADD CONSTRAINT "InvestorRight_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "InvestmentEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoardSeat" ADD CONSTRAINT "BoardSeat_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "InvestmentEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoardSeat" ADD CONSTRAINT "BoardSeat_investorId_fkey" FOREIGN KEY ("investorId") REFERENCES "InvestorProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestmentAgreement" ADD CONSTRAINT "InvestmentAgreement_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "InvestmentEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestmentAgreement" ADD CONSTRAINT "InvestmentAgreement_investmentId_fkey" FOREIGN KEY ("investmentId") REFERENCES "Investment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestmentAgreement" ADD CONSTRAINT "InvestmentAgreement_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "InvestmentRound"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestmentAgreement" ADD CONSTRAINT "InvestmentAgreement_investorId_fkey" FOREIGN KEY ("investorId") REFERENCES "InvestorProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExitEvent" ADD CONSTRAINT "ExitEvent_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "InvestmentEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExitDistribution" ADD CONSTRAINT "ExitDistribution_exitId_fkey" FOREIGN KEY ("exitId") REFERENCES "ExitEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExitDistribution" ADD CONSTRAINT "ExitDistribution_investorId_fkey" FOREIGN KEY ("investorId") REFERENCES "InvestorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestorDistribution" ADD CONSTRAINT "InvestorDistribution_investorId_fkey" FOREIGN KEY ("investorId") REFERENCES "InvestorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestorDistribution" ADD CONSTRAINT "InvestorDistribution_investmentId_fkey" FOREIGN KEY ("investmentId") REFERENCES "Investment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIDecision" ADD CONSTRAINT "AIDecision_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "AIModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIDecisionFeedback" ADD CONSTRAINT "AIDecisionFeedback_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "AIDecision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoIngestJob" ADD CONSTRAINT "VideoIngestJob_videoAssetId_fkey" FOREIGN KEY ("videoAssetId") REFERENCES "VideoAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisionAnalysisRun" ADD CONSTRAINT "VisionAnalysisRun_videoAssetId_fkey" FOREIGN KEY ("videoAssetId") REFERENCES "VideoAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerTrack" ADD CONSTRAINT "PlayerTrack_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "VisionAnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BallTrack" ADD CONSTRAINT "BallTrack_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "VisionAnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchEvent" ADD CONSTRAINT "MatchEvent_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "VisionAnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalyticsResult" ADD CONSTRAINT "AnalyticsResult_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "VisionAnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Clip" ADD CONSTRAINT "Clip_videoAssetId_fkey" FOREIGN KEY ("videoAssetId") REFERENCES "VideoAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveEvent" ADD CONSTRAINT "LiveEvent_streamId_fkey" FOREIGN KEY ("streamId") REFERENCES "LiveMatchStream"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowStep" ADD CONSTRAINT "WorkflowStep_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "ExecutiveWorkflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowAttestation" ADD CONSTRAINT "WorkflowAttestation_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "ExecutiveWorkflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowAttestation" ADD CONSTRAINT "WorkflowAttestation_attesterAssignmentId_fkey" FOREIGN KEY ("attesterAssignmentId") REFERENCES "ExecutiveAssignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoardResolution" ADD CONSTRAINT "BoardResolution_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "ExecutiveWorkflow"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoardVote" ADD CONSTRAINT "BoardVote_resolutionId_fkey" FOREIGN KEY ("resolutionId") REFERENCES "BoardResolution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoardVote" ADD CONSTRAINT "BoardVote_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "ExecutiveAssignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SponsorPipelineEvent" ADD CONSTRAINT "SponsorPipelineEvent_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "SponsorOpportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskAlert" ADD CONSTRAINT "RiskAlert_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "ExecutiveWorkflow"("id") ON DELETE SET NULL ON UPDATE CASCADE;


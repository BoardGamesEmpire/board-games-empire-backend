-- CreateEnum
CREATE TYPE "auth_types" AS ENUM ('ApiKey', 'Basic', 'Certificate', 'HMAC', 'JWT', 'None', 'OAuth', 'PSK');

-- CreateEnum
CREATE TYPE "pricing_models" AS ENUM ('Free', 'Freemium', 'Mixed', 'PaidUpfront', 'Subscription');

-- CreateEnum
CREATE TYPE "result_types" AS ENUM ('Custom', 'Elimination', 'Placement', 'Points', 'Score', 'Time');

-- CreateEnum
CREATE TYPE "sync_statuses" AS ENUM ('Success', 'Partial', 'Failed', 'InProgress');

-- CreateEnum
CREATE TYPE "time_measures" AS ENUM ('Minutes', 'Hours', 'Days', 'Weeks', 'Months', 'Years');

-- CreateEnum
CREATE TYPE "visibility_types" AS ENUM ('Friends', 'FriendsOfFriends', 'FriendsOfHouseholds', 'Household', 'Private', 'Public');

-- CreateEnum
CREATE TYPE "attendee_types" AS ENUM ('Participant', 'Guest', 'Organizer');

-- CreateEnum
CREATE TYPE "vote_types" AS ENUM ('For', 'Against', 'Interested');

-- CreateEnum
CREATE TYPE "event_participant_roles" AS ENUM ('CoHost', 'Guest', 'Host', 'Moderator', 'Organizer', 'Participant', 'Spectator');

-- CreateEnum
CREATE TYPE "event_participation_statuses" AS ENUM ('Attending', 'Invited', 'Maybe', 'NotAttending');

-- CreateEnum
CREATE TYPE "game_night_types" AS ENUM ('AdultsOnly', 'CasualGathering', 'CompetitivePlay', 'FamilyNight', 'KidFriendly', 'LearningSession', 'LongGameDay', 'MixedAges', 'PartyGames', 'StrategyNight');

-- CreateEnum
CREATE TYPE "artist_roles" AS ENUM ('Primary', 'Cover', 'Component', 'Illustration', 'Graphic', 'Supporting');

-- CreateEnum
CREATE TYPE "designer_roles" AS ENUM ('Primary', 'Secondary', 'Developer', 'Contributor');

-- CreateEnum
CREATE TYPE "family_types" AS ENUM ('Series', 'Universe', 'Reimplementation', 'System', 'Brand', 'Collection', 'Publisher');

-- CreateEnum
CREATE TYPE "publisher_roles" AS ENUM ('Primary', 'Localization', 'Distribution', 'Reprint');

-- CreateEnum
CREATE TYPE "game_conditions" AS ENUM ('Acceptable', 'Good', 'LikeNew', 'New', 'Poor', 'VeryGood');

-- CreateEnum
CREATE TYPE "loan_statuses" AS ENUM ('Active', 'Returned', 'Overdue', 'Cancelled');

-- CreateEnum
CREATE TYPE "game_play_contexts" AS ENUM ('Campaign', 'Casual', 'Competitive', 'Convention', 'Demo', 'League', 'OneShot', 'OrganizedEvent', 'Tournament', 'Virtual');

-- CreateEnum
CREATE TYPE "permissions" AS ENUM ('TransferOwnership', 'ManageRoles', 'ViewRoles', 'ManageUsers', 'ViewUsers', 'ViewOwnProfile', 'UpdateOwnProfile', 'CreateHousehold', 'UpdateHousehold', 'DeleteHousehold', 'ManageHouseholdMembers', 'CreateHouseholdRoles', 'ViewHousehold', 'JoinHousehold', 'InviteToHousehold', 'AddGameToCollection', 'RemoveGameFromCollection', 'UpdateGameInCollection', 'ViewGameCollection', 'ManageEvent', 'CreateEvent', 'UpdateEvent', 'DeleteEvent', 'ViewEvent', 'ManageEventParticipants', 'InviteToEvent', 'JoinEvent', 'CancelEvent', 'ArchiveEvent', 'ExportEventData', 'CreateGameSession', 'UpdateGameSession', 'DeleteGameSession', 'ViewGameSession', 'JoinGameSession', 'RecordGamePlay', 'CreateCampaign', 'UpdateCampaign', 'DeleteCampaign', 'ManageCampaignMembers', 'CreateRuleVariant', 'UpdateRuleVariant', 'DeleteRuleVariant', 'CreateGame', 'UpdateGame', 'DeleteGame', 'ModerateContent', 'ManageSystemSettings', 'ViewPublicContent', 'CreatePrivateGame', 'ViewPrivateGames', 'ApproveGameCreationRequests', 'CreateUserGameCustomization', 'UpdateUserGameCustomization', 'DeleteUserGameCustomization', 'ViewUserGameCustomization', 'ImportGameFromExternalAPI', 'ManageGameMetadata', 'ShareGameWithUser', 'ShareGameWithHousehold', 'EditSharedGame', 'ViewSharedGame', 'ChangeGameVisibility', 'ModerateMedia', 'UploadMedia', 'DeleteMedia');

-- CreateEnum
CREATE TYPE "resource_types" AS ENUM ('Campaign', 'Event', 'Game', 'GameCollection', 'GameCreationRequest', 'GameCustomization', 'GamePlaySession', 'GameSharing', 'Household', 'RuleVariant', 'System', 'User', 'UserGameCustomization');

-- CreateEnum
CREATE TYPE "SystemRole" AS ENUM ('Owner', 'Administrator', 'Moderator', 'User', 'Household Owner', 'Household Admin', 'Household Member', 'Household Guest', 'Event Host', 'Event Member', 'Event Guest');

-- CreateEnum
CREATE TYPE "rule_categories" AS ENUM ('ActionEconomy', 'Advancement', 'CharacterCreation', 'Combat', 'Condition', 'Custom', 'Economy', 'Environment', 'Equipment', 'Experience', 'General', 'Initiative', 'Magic', 'Movement', 'Other', 'RestAndRecovery', 'SocialInteraction');

-- CreateEnum
CREATE TYPE "rule_compatibility_modes" AS ENUM ('AllExpansions', 'AllVersions', 'BaseGameOnly', 'ExactMatch', 'SpecificExpansions', 'SpecificVersions');

-- CreateEnum
CREATE TYPE "rule_types" AS ENUM ('Addition', 'Clarification', 'Modification', 'Replacement', 'Restriction', 'Removal');

-- CreateEnum
CREATE TYPE "invite_statuses" AS ENUM ('Accepted', 'AwaitingApproval', 'Declined', 'Expired', 'Pending', 'Revoked', 'Withdrawn');

-- CreateEnum
CREATE TYPE "invite_types" AS ENUM ('Event', 'Household', 'System', 'Campaign');

-- CreateEnum
CREATE TYPE "sync_directions" AS ENUM ('FromSource', 'ToSource', 'Bidirectional');

-- CreateTable
CREATE TABLE "attendee_game_lists" (
    "id" TEXT NOT NULL,
    "attendee_id" TEXT NOT NULL,
    "collection_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendee_game_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_attendees" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "type" "attendee_types" NOT NULL DEFAULT 'Participant',
    "user_id" TEXT,
    "guest_name" TEXT,
    "guest_email" TEXT,
    "status" "event_participation_statuses" NOT NULL DEFAULT 'Invited',
    "role" "event_participant_roles" NOT NULL DEFAULT 'Participant',
    "invited_by_id" TEXT,
    "notes" TEXT,
    "rsvp_date" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "event_attendees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_game_votes" (
    "id" TEXT NOT NULL,
    "event_game_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "event_id" TEXT,
    "vote_type" "vote_types" NOT NULL,
    "priority" INTEGER,
    "comment" TEXT,

    CONSTRAINT "event_game_votes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_games" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "suggested_by_id" TEXT NOT NULL,

    CONSTRAINT "event_games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_member_permissions" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "permission" "permissions" NOT NULL,
    "granted_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "event_member_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "household_id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "image" TEXT,
    "description" TEXT,
    "location" TEXT,
    "url" TEXT,
    "type" "game_night_types" NOT NULL DEFAULT 'CasualGathering',
    "visibility" "visibility_types" NOT NULL DEFAULT 'Friends',
    "allow_guest_invites" BOOLEAN NOT NULL DEFAULT true,
    "max_total_participants" INTEGER,
    "strict_capacity" BOOLEAN NOT NULL DEFAULT false,
    "start_date" TIMESTAMPTZ(3) NOT NULL,
    "end_date" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expansion_compatibilities" (
    "id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "expansion_id" TEXT NOT NULL,
    "is_recommended" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "expansion_compatibilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_collections" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "rating" INTEGER,
    "play_count" INTEGER,
    "play_again" BOOLEAN,
    "favorite" BOOLEAN,
    "comment" TEXT,
    "last_played" TIMESTAMPTZ(3),
    "last_updated" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "game_collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_expansion_rule_variants" (
    "id" TEXT NOT NULL,
    "rule_variant_id" TEXT NOT NULL,
    "game_expansion_id" TEXT NOT NULL,
    "override_category" "rule_categories",
    "override_rule_text" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ruleVariantUsageId" TEXT,

    CONSTRAINT "game_expansion_rule_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_expansions" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "base_game_id" TEXT NOT NULL,
    "description" TEXT,
    "release_year" INTEGER,
    "is_standalone" BOOLEAN NOT NULL DEFAULT false,
    "parent_expansion_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "game_expansions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_gateways" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "message_context" TEXT,
    "icon_url" TEXT,
    "logo_url" TEXT,
    "website_url" TEXT,
    "base_url" TEXT,
    "api_documentation" TEXT,
    "api_version" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "auth_type" "auth_types" NOT NULL,
    "auth_parameters" JSONB,
    "usage_count" INTEGER NOT NULL DEFAULT 0,
    "last_used" TIMESTAMPTZ(3),
    "created_by_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "game_gateways_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_locations" (
    "id" TEXT NOT NULL,
    "collection_id" TEXT,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "household_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "game_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_sources" (
    "id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "gateway_id" TEXT,
    "external_id" TEXT,
    "source_url" TEXT,
    "metadata" JSONB,
    "last_synced" TIMESTAMPTZ(3),
    "sync_enabled" BOOLEAN NOT NULL DEFAULT true,
    "sync_interval" INTEGER,
    "title" TEXT,
    "url" TEXT,
    "publisher_id" TEXT,
    "release_date" TIMESTAMPTZ(3),
    "version" TEXT,
    "last_updated" TIMESTAMPTZ(3),
    "pricing_model" "pricing_models",
    "base_price" DOUBLE PRECISION,
    "has_purchases" BOOLEAN NOT NULL DEFAULT false,
    "is_subscription" BOOLEAN NOT NULL DEFAULT false,
    "supports_solo" BOOLEAN NOT NULL DEFAULT false,
    "supports_local" BOOLEAN NOT NULL DEFAULT false,
    "supports_online" BOOLEAN NOT NULL DEFAULT false,
    "has_async_play" BOOLEAN NOT NULL DEFAULT false,
    "has_realtime" BOOLEAN NOT NULL DEFAULT false,
    "has_tutorial" BOOLEAN NOT NULL DEFAULT false,
    "store_identifiers" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "game_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_version_rule_variants" (
    "id" TEXT NOT NULL,
    "rule_variant_id" TEXT NOT NULL,
    "game_version_id" TEXT NOT NULL,
    "override_category" "rule_categories",
    "override_rule_text" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ruleVariantUsageId" TEXT,

    CONSTRAINT "game_version_rule_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_versions" (
    "id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "version_name" TEXT NOT NULL,
    "release_year" INTEGER,
    "is_baseline" BOOLEAN NOT NULL DEFAULT false,
    "parent_version_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "game_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "games" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "description" TEXT,
    "image" TEXT,
    "publish_year" INTEGER,
    "min_players" INTEGER,
    "max_players" INTEGER,
    "playing_time" INTEGER,
    "min_play_time" INTEGER,
    "min_play_time_measure" "time_measures",
    "max_play_time" INTEGER,
    "max_play_time_measure" "time_measures",
    "min_age" INTEGER,
    "complexity" DOUBLE PRECISION,
    "total_play_count" INTEGER NOT NULL DEFAULT 0,
    "average_rating" DOUBLE PRECISION,
    "owned_by_count" INTEGER NOT NULL DEFAULT 0,
    "visibility" "visibility_types" NOT NULL DEFAULT 'Public',
    "created_by_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artists" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "full_name" TEXT,
    "website" TEXT,
    "biography" TEXT,
    "country" TEXT,
    "social_media" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "artists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_artists" (
    "id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "artist_id" TEXT NOT NULL,
    "role" "artist_roles" NOT NULL DEFAULT 'Primary',
    "details" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "game_artists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "parent_category_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_categories" (
    "id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "game_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "designers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "full_name" TEXT,
    "website" TEXT,
    "biography" TEXT,
    "country" TEXT,
    "board_game_geek_url" TEXT,
    "debut_year" INTEGER,
    "total_collaborators" INTEGER,
    "most_frequent_collaborator_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "designers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_designers" (
    "id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "designer_id" TEXT NOT NULL,
    "role" "designer_roles" NOT NULL DEFAULT 'Primary',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "game_designers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "families" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "publisher_id" TEXT,
    "logo_url" TEXT,
    "website" TEXT,
    "family_type" "family_types" NOT NULL DEFAULT 'Series',
    "parent_family_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "families_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_families" (
    "id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "position" INTEGER,
    "release_order" INTEGER,
    "story_order" INTEGER,
    "is_standalone" BOOLEAN NOT NULL DEFAULT true,
    "required_game_ids" TEXT[],
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "game_families_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mechanics" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "complexity" INTEGER,
    "usage_count" INTEGER,
    "compatibility_score" DOUBLE PRECISION,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "mechanics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_mechanics" (
    "id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "mechanic_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "game_mechanics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publishers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legal_name" TEXT,
    "website" TEXT,
    "country" TEXT,
    "founded_year" INTEGER,
    "parent_company_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "logo_url" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "publishers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_publishers" (
    "id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "publisher_id" TEXT NOT NULL,
    "role" "publisher_roles" NOT NULL DEFAULT 'Primary',
    "release_year" INTEGER,
    "region" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "game_publishers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_tags" (
    "id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "tag_id" TEXT NOT NULL,
    "added_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loaned_games" (
    "id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "collection_id" TEXT NOT NULL,
    "lender_id" TEXT NOT NULL,
    "borrower_id" TEXT,
    "borrower_name" TEXT,
    "borrower_email" TEXT,
    "loan_date" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expected_return_date" TIMESTAMPTZ(3),
    "returned_date" TIMESTAMPTZ(3),
    "status" "loan_statuses" NOT NULL DEFAULT 'Active',
    "condition_at_loan" "game_conditions",
    "condition_at_return" "game_conditions",
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "loaned_games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_play_results" (
    "id" TEXT NOT NULL,
    "game_play_session_id" TEXT NOT NULL,
    "result_type" "result_types" NOT NULL DEFAULT 'Score',
    "scoring_phase" TEXT,
    "score_details" JSONB,
    "team_scores" JSONB,
    "individual_metrics" JSONB,

    CONSTRAINT "game_play_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_play_session_expansions" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "expansion_id" TEXT NOT NULL,

    CONSTRAINT "game_play_session_expansions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_play_sessions" (
    "id" TEXT NOT NULL,
    "event_id" TEXT,
    "game_id" TEXT NOT NULL,
    "game_version_id" TEXT,
    "session_number" INTEGER,
    "table_number" INTEGER,
    "chapter" TEXT,
    "milestone" TEXT,
    "play_date" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "duration" INTEGER,
    "location" TEXT,
    "context" "game_play_contexts" NOT NULL DEFAULT 'Casual',
    "household_id" TEXT,
    "venue" TEXT,
    "is_complete" BOOLEAN NOT NULL DEFAULT false,
    "was_interrupted" BOOLEAN NOT NULL DEFAULT false,
    "playtime" INTEGER,
    "turns" INTEGER,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "game_play_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_players" (
    "id" TEXT NOT NULL,
    "game_play_session_id" TEXT NOT NULL,
    "user_id" TEXT,
    "guest_name" TEXT,
    "player_position" INTEGER,
    "team" TEXT,
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMPTZ(3),
    "final_score" DOUBLE PRECISION,
    "placement" INTEGER,
    "won" BOOLEAN,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "session_players_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "excluded_games" (
    "id" TEXT NOT NULL,
    "household_member_id" TEXT NOT NULL,
    "game_collection_id" TEXT NOT NULL,
    "excluded_reason" TEXT,
    "excluded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "excluded_games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "household_members" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "household_id" TEXT NOT NULL,
    "show_all_games" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "household_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "household_roles" (
    "id" TEXT NOT NULL,
    "household_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "household_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "households" (
    "id" TEXT NOT NULL,
    "description" TEXT,
    "name" TEXT NOT NULL,
    "image" TEXT,
    "language_id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "households_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_lists" (
    "id" TEXT NOT NULL,
    "list_id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "game_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lists" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'My Wishlist',
    "user_id" TEXT NOT NULL,

    CONSTRAINT "lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_documents" (
    "id" TEXT NOT NULL,
    "media_id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "page_count" INTEGER,
    "format" TEXT NOT NULL,
    "category" TEXT,

    CONSTRAINT "game_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_documents" (
    "id" TEXT NOT NULL,
    "media_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "page_count" INTEGER,
    "format" TEXT NOT NULL,
    "category" TEXT,

    CONSTRAINT "event_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_images" (
    "id" TEXT NOT NULL,
    "media_id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "format" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_cover" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "game_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_images" (
    "id" TEXT NOT NULL,
    "media_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "format" TEXT NOT NULL,
    "is_featured" BOOLEAN NOT NULL DEFAULT false,
    "taken_at" TIMESTAMPTZ(3),

    CONSTRAINT "event_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_videos" (
    "id" TEXT NOT NULL,
    "media_id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "duration" INTEGER NOT NULL,
    "codec" TEXT,
    "resolution" TEXT,
    "is_trailer" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "game_videos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_videos" (
    "id" TEXT NOT NULL,
    "media_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "duration" INTEGER NOT NULL,
    "codec" TEXT,
    "resolution" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "event_videos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "thumbnail_url" TEXT,
    "title" TEXT,
    "caption" TEXT,
    "alt_text" TEXT,
    "file_size" INTEGER,
    "mime_type" TEXT,
    "original_name" TEXT,
    "uploader_id" TEXT NOT NULL,
    "visibility" "visibility_types" NOT NULL DEFAULT 'Public',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "permission" "permissions" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_variant_usage_expansions" (
    "id" TEXT NOT NULL,
    "rule_variant_usage_id" TEXT NOT NULL,
    "game_expansion_id" TEXT NOT NULL,
    "was_applicable" BOOLEAN NOT NULL DEFAULT true,
    "required_modification" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,

    CONSTRAINT "rule_variant_usage_expansions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_variant_usage_versions" (
    "id" TEXT NOT NULL,
    "rule_variant_usage_id" TEXT NOT NULL,
    "game_version_id" TEXT NOT NULL,
    "was_applicable" BOOLEAN NOT NULL DEFAULT true,
    "requires_errata" BOOLEAN NOT NULL DEFAULT false,
    "errata_details" TEXT,

    CONSTRAINT "rule_variant_usage_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_variant_usages" (
    "id" TEXT NOT NULL,
    "rule_variant_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "was_voted_on" BOOLEAN,
    "votes_for" INTEGER,
    "votes_against" INTEGER,
    "was_effective" BOOLEAN,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rule_variant_usages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_variants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "game_id" TEXT,
    "household_id" TEXT,
    "category" "rule_categories" NOT NULL DEFAULT 'General',
    "rule_type" "rule_types" NOT NULL DEFAULT 'Addition',
    "compatibility_mode" "rule_compatibility_modes" NOT NULL DEFAULT 'ExactMatch',
    "modifies_core" BOOLEAN NOT NULL DEFAULT false,
    "replaced_rule_ref" TEXT,
    "rulebook_page" INTEGER,
    "rulebook_edition" TEXT,
    "ruleText" TEXT NOT NULL,
    "examples" TEXT,
    "created_by_id" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT,
    "discussion_link" TEXT,
    "version" TEXT NOT NULL DEFAULT '1.0',
    "previous_version_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rule_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invites" (
    "id" TEXT NOT NULL,
    "status" "invite_statuses" NOT NULL DEFAULT 'Pending',
    "type" "invite_types" NOT NULL,
    "inviter_id" TEXT NOT NULL,
    "invitee_id" TEXT,
    "invitee_email" TEXT,
    "invitee_name" TEXT,
    "event_id" TEXT,
    "household_id" TEXT,
    "role_id" TEXT,
    "message" TEXT,
    "metadata" JSONB,
    "token" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "needs_approval" BOOLEAN NOT NULL DEFAULT false,
    "approved_by_id" TEXT,
    "approved_at" TIMESTAMPTZ(3),
    "responded_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "languages" (
    "abbreviation" VARCHAR(2) NOT NULL,
    "code" VARCHAR(3) NOT NULL,
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "languages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "id" TEXT NOT NULL,
    "allow_password_resets" BOOLEAN NOT NULL DEFAULT true,
    "allow_user_registration" BOOLEAN NOT NULL DEFAULT true,
    "allow_username_change" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_game_customizations" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "game_id" TEXT NOT NULL,
    "title" TEXT,
    "subtitle" TEXT,
    "description" TEXT,
    "image" TEXT,
    "publish_year" INTEGER,
    "min_players" INTEGER,
    "max_players" INTEGER,
    "playing_time" INTEGER,
    "min_play_time" INTEGER,
    "max_play_time" INTEGER,
    "min_age" INTEGER,
    "complexity" DOUBLE PRECISION,
    "customization_notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_game_customizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_gateway_connections" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "gateway_id" TEXT NOT NULL,
    "external_user_id" TEXT NOT NULL,
    "external_username" TEXT,
    "profile_url" TEXT,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "token_expiry" TIMESTAMPTZ(3),
    "sync_enabled" BOOLEAN NOT NULL DEFAULT true,
    "sync_interval" INTEGER NOT NULL DEFAULT 24,
    "sync_direction" "sync_directions" NOT NULL DEFAULT 'FromSource',
    "auto_add_to_collection" BOOLEAN NOT NULL DEFAULT true,
    "settings" JSONB,
    "last_synced_at" TIMESTAMPTZ(3),
    "last_sync_status" "sync_statuses",
    "last_sync_error" TEXT,
    "consecutive_errors" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_gateway_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_gateway_sync_logs" (
    "id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),
    "status" "sync_statuses" NOT NULL,
    "games_added" INTEGER NOT NULL DEFAULT 0,
    "games_updated" INTEGER NOT NULL DEFAULT 0,
    "games_removed" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB,

    CONSTRAINT "user_gateway_sync_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_permissions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "permission" "permissions" NOT NULL,
    "resource_type" "resource_types" NOT NULL,
    "resource_id" TEXT,
    "granted_by_id" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_preferences" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "theme" TEXT NOT NULL DEFAULT 'system',
    "accent_color" TEXT,
    "show_online_status" BOOLEAN NOT NULL DEFAULT true,
    "show_last_active" BOOLEAN NOT NULL DEFAULT true,
    "allow_friend_requests" BOOLEAN NOT NULL DEFAULT true,
    "show_collection_to_friends" BOOLEAN NOT NULL DEFAULT true,
    "show_game_play_history" BOOLEAN NOT NULL DEFAULT true,
    "email_notifications" JSONB,
    "push_notifications" JSONB,
    "preferred_player_count" INTEGER,
    "preferred_game_length" INTEGER,
    "favorite_categories" TEXT[],
    "favorite_mechanics" TEXT[],
    "disliked_categories" TEXT[],
    "disliked_mechanics" TEXT[],
    "language_id" TEXT,
    "default_review_visibility" "visibility_types" NOT NULL DEFAULT 'Private',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "attendee_game_lists_attendee_id_idx" ON "attendee_game_lists"("attendee_id");

-- CreateIndex
CREATE UNIQUE INDEX "attendee_game_lists_attendee_id_collection_id_key" ON "attendee_game_lists"("attendee_id", "collection_id");

-- CreateIndex
CREATE INDEX "event_attendees_event_id_idx" ON "event_attendees"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_attendees_event_id_user_id_key" ON "event_attendees"("event_id", "user_id");

-- CreateIndex
CREATE INDEX "event_game_votes_user_id_idx" ON "event_game_votes"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_game_votes_event_game_id_user_id_key" ON "event_game_votes"("event_game_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "event_member_permissions_event_id_user_id_permission_key" ON "event_member_permissions"("event_id", "user_id", "permission");

-- CreateIndex
CREATE INDEX "events_household_id_idx" ON "events"("household_id");

-- CreateIndex
CREATE INDEX "events_created_by_id_idx" ON "events"("created_by_id");

-- CreateIndex
CREATE INDEX "events_start_date_idx" ON "events"("start_date");

-- CreateIndex
CREATE UNIQUE INDEX "expansion_compatibilities_game_id_expansion_id_key" ON "expansion_compatibilities"("game_id", "expansion_id");

-- CreateIndex
CREATE INDEX "game_collections_user_id_idx" ON "game_collections"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "game_collections_user_id_game_id_key" ON "game_collections"("user_id", "game_id");

-- CreateIndex
CREATE UNIQUE INDEX "game_expansion_rule_variants_rule_variant_id_game_expansion_key" ON "game_expansion_rule_variants"("rule_variant_id", "game_expansion_id");

-- CreateIndex
CREATE INDEX "game_expansions_base_game_id_idx" ON "game_expansions"("base_game_id");

-- CreateIndex
CREATE INDEX "game_expansions_parent_expansion_id_idx" ON "game_expansions"("parent_expansion_id");

-- CreateIndex
CREATE UNIQUE INDEX "game_gateways_name_key" ON "game_gateways"("name");

-- CreateIndex
CREATE INDEX "game_locations_collection_id_idx" ON "game_locations"("collection_id");

-- CreateIndex
CREATE INDEX "game_sources_gateway_id_idx" ON "game_sources"("gateway_id");

-- CreateIndex
CREATE INDEX "game_sources_last_synced_idx" ON "game_sources"("last_synced");

-- CreateIndex
CREATE UNIQUE INDEX "game_sources_game_id_external_id_key" ON "game_sources"("game_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "game_version_rule_variants_rule_variant_id_game_version_id_key" ON "game_version_rule_variants"("rule_variant_id", "game_version_id");

-- CreateIndex
CREATE INDEX "game_versions_game_id_idx" ON "game_versions"("game_id");

-- CreateIndex
CREATE INDEX "game_versions_parent_version_id_idx" ON "game_versions"("parent_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "game_artists_game_id_artist_id_key" ON "game_artists"("game_id", "artist_id");

-- CreateIndex
CREATE UNIQUE INDEX "categories_name_key" ON "categories"("name");

-- CreateIndex
CREATE UNIQUE INDEX "game_categories_game_id_category_id_key" ON "game_categories"("game_id", "category_id");

-- CreateIndex
CREATE UNIQUE INDEX "unique_primary_category_per_game" ON "game_categories"("game_id", "is_primary");

-- CreateIndex
CREATE UNIQUE INDEX "designers_name_key" ON "designers"("name");

-- CreateIndex
CREATE UNIQUE INDEX "game_designers_game_id_designer_id_key" ON "game_designers"("game_id", "designer_id");

-- CreateIndex
CREATE UNIQUE INDEX "families_name_key" ON "families"("name");

-- CreateIndex
CREATE UNIQUE INDEX "game_families_game_id_family_id_key" ON "game_families"("game_id", "family_id");

-- CreateIndex
CREATE UNIQUE INDEX "mechanics_name_key" ON "mechanics"("name");

-- CreateIndex
CREATE UNIQUE INDEX "game_mechanics_game_id_mechanic_id_key" ON "game_mechanics"("game_id", "mechanic_id");

-- CreateIndex
CREATE UNIQUE INDEX "publishers_name_key" ON "publishers"("name");

-- CreateIndex
CREATE UNIQUE INDEX "game_publishers_game_id_publisher_id_key" ON "game_publishers"("game_id", "publisher_id");

-- CreateIndex
CREATE UNIQUE INDEX "tags_name_key" ON "tags"("name");

-- CreateIndex
CREATE UNIQUE INDEX "game_tags_game_id_tag_id_key" ON "game_tags"("game_id", "tag_id");

-- CreateIndex
CREATE INDEX "loaned_games_lender_id_idx" ON "loaned_games"("lender_id");

-- CreateIndex
CREATE INDEX "loaned_games_borrower_id_idx" ON "loaned_games"("borrower_id");

-- CreateIndex
CREATE INDEX "loaned_games_collection_id_idx" ON "loaned_games"("collection_id");

-- CreateIndex
CREATE INDEX "loaned_games_status_idx" ON "loaned_games"("status");

-- CreateIndex
CREATE INDEX "game_play_results_game_play_session_id_idx" ON "game_play_results"("game_play_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "game_play_session_expansions_session_id_expansion_id_key" ON "game_play_session_expansions"("session_id", "expansion_id");

-- CreateIndex
CREATE INDEX "game_play_sessions_event_id_idx" ON "game_play_sessions"("event_id");

-- CreateIndex
CREATE INDEX "game_play_sessions_game_id_idx" ON "game_play_sessions"("game_id");

-- CreateIndex
CREATE INDEX "game_play_sessions_play_date_idx" ON "game_play_sessions"("play_date");

-- CreateIndex
CREATE INDEX "session_players_user_id_idx" ON "session_players"("user_id");

-- CreateIndex
CREATE INDEX "session_players_game_play_session_id_idx" ON "session_players"("game_play_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "session_players_game_play_session_id_user_id_key" ON "session_players"("game_play_session_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "excluded_games_household_member_id_game_collection_id_key" ON "excluded_games"("household_member_id", "game_collection_id");

-- CreateIndex
CREATE UNIQUE INDEX "household_members_household_id_user_id_key" ON "household_members"("household_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "household_roles_household_id_user_id_role_id_key" ON "household_roles"("household_id", "user_id", "role_id");

-- CreateIndex
CREATE INDEX "game_documents_game_id_idx" ON "game_documents"("game_id");

-- CreateIndex
CREATE INDEX "event_documents_event_id_idx" ON "event_documents"("event_id");

-- CreateIndex
CREATE INDEX "game_images_game_id_idx" ON "game_images"("game_id");

-- CreateIndex
CREATE INDEX "event_images_event_id_idx" ON "event_images"("event_id");

-- CreateIndex
CREATE INDEX "game_videos_game_id_idx" ON "game_videos"("game_id");

-- CreateIndex
CREATE INDEX "event_videos_event_id_idx" ON "event_videos"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- CreateIndex
CREATE UNIQUE INDEX "role_permissions_role_id_permission_key" ON "role_permissions"("role_id", "permission");

-- CreateIndex
CREATE UNIQUE INDEX "rule_variant_usage_expansions_rule_variant_usage_id_game_ex_key" ON "rule_variant_usage_expansions"("rule_variant_usage_id", "game_expansion_id");

-- CreateIndex
CREATE UNIQUE INDEX "rule_variant_usage_versions_rule_variant_usage_id_game_vers_key" ON "rule_variant_usage_versions"("rule_variant_usage_id", "game_version_id");

-- CreateIndex
CREATE INDEX "rule_variant_usages_session_id_idx" ON "rule_variant_usages"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "rule_variant_usages_rule_variant_id_session_id_key" ON "rule_variant_usages"("rule_variant_id", "session_id");

-- CreateIndex
CREATE UNIQUE INDEX "rule_variants_previous_version_id_key" ON "rule_variants"("previous_version_id");

-- CreateIndex
CREATE INDEX "rule_variants_game_id_idx" ON "rule_variants"("game_id");

-- CreateIndex
CREATE INDEX "rule_variants_household_id_idx" ON "rule_variants"("household_id");

-- CreateIndex
CREATE UNIQUE INDEX "invites_token_key" ON "invites"("token");

-- CreateIndex
CREATE INDEX "invites_invitee_id_idx" ON "invites"("invitee_id");

-- CreateIndex
CREATE INDEX "invites_invitee_email_idx" ON "invites"("invitee_email");

-- CreateIndex
CREATE INDEX "invites_status_idx" ON "invites"("status");

-- CreateIndex
CREATE INDEX "invites_type_status_idx" ON "invites"("type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "languages_abbreviation_key" ON "languages"("abbreviation");

-- CreateIndex
CREATE UNIQUE INDEX "languages_code_key" ON "languages"("code");

-- CreateIndex
CREATE UNIQUE INDEX "languages_name_key" ON "languages"("name");

-- CreateIndex
CREATE UNIQUE INDEX "user_game_customizations_user_id_game_id_key" ON "user_game_customizations"("user_id", "game_id");

-- CreateIndex
CREATE INDEX "user_gateway_connections_user_id_idx" ON "user_gateway_connections"("user_id");

-- CreateIndex
CREATE INDEX "user_gateway_connections_last_synced_at_idx" ON "user_gateway_connections"("last_synced_at");

-- CreateIndex
CREATE UNIQUE INDEX "user_gateway_connections_user_id_gateway_id_external_user_i_key" ON "user_gateway_connections"("user_id", "gateway_id", "external_user_id");

-- CreateIndex
CREATE INDEX "user_gateway_sync_logs_connection_id_idx" ON "user_gateway_sync_logs"("connection_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_permissions_user_id_permission_resource_type_resource__key" ON "user_permissions"("user_id", "permission", "resource_type", "resource_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_preferences_user_id_key" ON "user_preferences"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_roles_user_id_role_id_key" ON "user_roles"("user_id", "role_id");

-- AddForeignKey
ALTER TABLE "attendee_game_lists" ADD CONSTRAINT "attendee_game_lists_attendee_id_fkey" FOREIGN KEY ("attendee_id") REFERENCES "event_attendees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendee_game_lists" ADD CONSTRAINT "attendee_game_lists_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "game_collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_attendees" ADD CONSTRAINT "event_attendees_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_attendees" ADD CONSTRAINT "event_attendees_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_attendees" ADD CONSTRAINT "event_attendees_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "event_attendees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_game_votes" ADD CONSTRAINT "event_game_votes_event_game_id_fkey" FOREIGN KEY ("event_game_id") REFERENCES "event_games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_game_votes" ADD CONSTRAINT "event_game_votes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_game_votes" ADD CONSTRAINT "event_game_votes_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_games" ADD CONSTRAINT "event_games_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_games" ADD CONSTRAINT "event_games_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_games" ADD CONSTRAINT "event_games_suggested_by_id_fkey" FOREIGN KEY ("suggested_by_id") REFERENCES "event_attendees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_member_permissions" ADD CONSTRAINT "event_member_permissions_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_member_permissions" ADD CONSTRAINT "event_member_permissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_member_permissions" ADD CONSTRAINT "event_member_permissions_granted_by_id_fkey" FOREIGN KEY ("granted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expansion_compatibilities" ADD CONSTRAINT "expansion_compatibilities_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expansion_compatibilities" ADD CONSTRAINT "expansion_compatibilities_expansion_id_fkey" FOREIGN KEY ("expansion_id") REFERENCES "game_expansions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_collections" ADD CONSTRAINT "game_collections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_collections" ADD CONSTRAINT "game_collections_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_expansion_rule_variants" ADD CONSTRAINT "game_expansion_rule_variants_rule_variant_id_fkey" FOREIGN KEY ("rule_variant_id") REFERENCES "rule_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_expansion_rule_variants" ADD CONSTRAINT "game_expansion_rule_variants_game_expansion_id_fkey" FOREIGN KEY ("game_expansion_id") REFERENCES "game_expansions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_expansion_rule_variants" ADD CONSTRAINT "game_expansion_rule_variants_ruleVariantUsageId_fkey" FOREIGN KEY ("ruleVariantUsageId") REFERENCES "rule_variant_usages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_expansions" ADD CONSTRAINT "game_expansions_base_game_id_fkey" FOREIGN KEY ("base_game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_expansions" ADD CONSTRAINT "game_expansions_parent_expansion_id_fkey" FOREIGN KEY ("parent_expansion_id") REFERENCES "game_expansions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_gateways" ADD CONSTRAINT "game_gateways_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_locations" ADD CONSTRAINT "game_locations_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "game_collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_locations" ADD CONSTRAINT "game_locations_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_sources" ADD CONSTRAINT "game_sources_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_sources" ADD CONSTRAINT "game_sources_gateway_id_fkey" FOREIGN KEY ("gateway_id") REFERENCES "game_gateways"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_sources" ADD CONSTRAINT "game_sources_publisher_id_fkey" FOREIGN KEY ("publisher_id") REFERENCES "publishers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_version_rule_variants" ADD CONSTRAINT "game_version_rule_variants_rule_variant_id_fkey" FOREIGN KEY ("rule_variant_id") REFERENCES "rule_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_version_rule_variants" ADD CONSTRAINT "game_version_rule_variants_game_version_id_fkey" FOREIGN KEY ("game_version_id") REFERENCES "game_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_version_rule_variants" ADD CONSTRAINT "game_version_rule_variants_ruleVariantUsageId_fkey" FOREIGN KEY ("ruleVariantUsageId") REFERENCES "rule_variant_usages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_versions" ADD CONSTRAINT "game_versions_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_versions" ADD CONSTRAINT "game_versions_parent_version_id_fkey" FOREIGN KEY ("parent_version_id") REFERENCES "game_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "games" ADD CONSTRAINT "games_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_artists" ADD CONSTRAINT "game_artists_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_artists" ADD CONSTRAINT "game_artists_artist_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "artists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_category_id_fkey" FOREIGN KEY ("parent_category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_categories" ADD CONSTRAINT "game_categories_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_categories" ADD CONSTRAINT "game_categories_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_designers" ADD CONSTRAINT "game_designers_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_designers" ADD CONSTRAINT "game_designers_designer_id_fkey" FOREIGN KEY ("designer_id") REFERENCES "designers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "families" ADD CONSTRAINT "families_publisher_id_fkey" FOREIGN KEY ("publisher_id") REFERENCES "publishers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "families" ADD CONSTRAINT "families_parent_family_id_fkey" FOREIGN KEY ("parent_family_id") REFERENCES "families"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_families" ADD CONSTRAINT "game_families_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_families" ADD CONSTRAINT "game_families_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_mechanics" ADD CONSTRAINT "game_mechanics_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_mechanics" ADD CONSTRAINT "game_mechanics_mechanic_id_fkey" FOREIGN KEY ("mechanic_id") REFERENCES "mechanics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publishers" ADD CONSTRAINT "publishers_parent_company_id_fkey" FOREIGN KEY ("parent_company_id") REFERENCES "publishers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_publishers" ADD CONSTRAINT "game_publishers_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_publishers" ADD CONSTRAINT "game_publishers_publisher_id_fkey" FOREIGN KEY ("publisher_id") REFERENCES "publishers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_tags" ADD CONSTRAINT "game_tags_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_tags" ADD CONSTRAINT "game_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_tags" ADD CONSTRAINT "game_tags_added_by_id_fkey" FOREIGN KEY ("added_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loaned_games" ADD CONSTRAINT "loaned_games_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loaned_games" ADD CONSTRAINT "loaned_games_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "game_collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loaned_games" ADD CONSTRAINT "loaned_games_lender_id_fkey" FOREIGN KEY ("lender_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loaned_games" ADD CONSTRAINT "loaned_games_borrower_id_fkey" FOREIGN KEY ("borrower_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_play_results" ADD CONSTRAINT "game_play_results_game_play_session_id_fkey" FOREIGN KEY ("game_play_session_id") REFERENCES "game_play_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_play_session_expansions" ADD CONSTRAINT "game_play_session_expansions_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "game_play_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_play_session_expansions" ADD CONSTRAINT "game_play_session_expansions_expansion_id_fkey" FOREIGN KEY ("expansion_id") REFERENCES "game_expansions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_play_sessions" ADD CONSTRAINT "game_play_sessions_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_play_sessions" ADD CONSTRAINT "game_play_sessions_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_play_sessions" ADD CONSTRAINT "game_play_sessions_game_version_id_fkey" FOREIGN KEY ("game_version_id") REFERENCES "game_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_play_sessions" ADD CONSTRAINT "game_play_sessions_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_players" ADD CONSTRAINT "session_players_game_play_session_id_fkey" FOREIGN KEY ("game_play_session_id") REFERENCES "game_play_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_players" ADD CONSTRAINT "session_players_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "excluded_games" ADD CONSTRAINT "excluded_games_household_member_id_fkey" FOREIGN KEY ("household_member_id") REFERENCES "household_members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "excluded_games" ADD CONSTRAINT "excluded_games_game_collection_id_fkey" FOREIGN KEY ("game_collection_id") REFERENCES "game_collections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "household_roles" ADD CONSTRAINT "household_roles_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "household_roles" ADD CONSTRAINT "household_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "household_roles" ADD CONSTRAINT "household_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "households" ADD CONSTRAINT "households_language_id_fkey" FOREIGN KEY ("language_id") REFERENCES "languages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "households" ADD CONSTRAINT "households_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_lists" ADD CONSTRAINT "game_lists_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "lists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_lists" ADD CONSTRAINT "game_lists_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lists" ADD CONSTRAINT "lists_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_documents" ADD CONSTRAINT "game_documents_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_documents" ADD CONSTRAINT "game_documents_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_documents" ADD CONSTRAINT "event_documents_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_documents" ADD CONSTRAINT "event_documents_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_images" ADD CONSTRAINT "game_images_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_images" ADD CONSTRAINT "game_images_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_images" ADD CONSTRAINT "event_images_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_images" ADD CONSTRAINT "event_images_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_videos" ADD CONSTRAINT "game_videos_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_videos" ADD CONSTRAINT "game_videos_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_videos" ADD CONSTRAINT "event_videos_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_videos" ADD CONSTRAINT "event_videos_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media" ADD CONSTRAINT "media_uploader_id_fkey" FOREIGN KEY ("uploader_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_variant_usage_expansions" ADD CONSTRAINT "rule_variant_usage_expansions_rule_variant_usage_id_fkey" FOREIGN KEY ("rule_variant_usage_id") REFERENCES "rule_variant_usages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_variant_usage_expansions" ADD CONSTRAINT "rule_variant_usage_expansions_game_expansion_id_fkey" FOREIGN KEY ("game_expansion_id") REFERENCES "game_expansions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_variant_usage_versions" ADD CONSTRAINT "rule_variant_usage_versions_rule_variant_usage_id_fkey" FOREIGN KEY ("rule_variant_usage_id") REFERENCES "rule_variant_usages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_variant_usage_versions" ADD CONSTRAINT "rule_variant_usage_versions_game_version_id_fkey" FOREIGN KEY ("game_version_id") REFERENCES "game_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_variant_usages" ADD CONSTRAINT "rule_variant_usages_rule_variant_id_fkey" FOREIGN KEY ("rule_variant_id") REFERENCES "rule_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_variant_usages" ADD CONSTRAINT "rule_variant_usages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "game_play_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_variants" ADD CONSTRAINT "rule_variants_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_variants" ADD CONSTRAINT "rule_variants_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_variants" ADD CONSTRAINT "rule_variants_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_variants" ADD CONSTRAINT "rule_variants_previous_version_id_fkey" FOREIGN KEY ("previous_version_id") REFERENCES "rule_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_inviter_id_fkey" FOREIGN KEY ("inviter_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_invitee_id_fkey" FOREIGN KEY ("invitee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_game_customizations" ADD CONSTRAINT "user_game_customizations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_game_customizations" ADD CONSTRAINT "user_game_customizations_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_gateway_connections" ADD CONSTRAINT "user_gateway_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_gateway_connections" ADD CONSTRAINT "user_gateway_connections_gateway_id_fkey" FOREIGN KEY ("gateway_id") REFERENCES "game_gateways"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_gateway_sync_logs" ADD CONSTRAINT "user_gateway_sync_logs_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "user_gateway_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_granted_by_id_fkey" FOREIGN KEY ("granted_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_language_id_fkey" FOREIGN KEY ("language_id") REFERENCES "languages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

export enum AgeRatingOrganization {
  ESRB = 1,
  PEGI = 2,
  CERO = 3,
  USK = 4,
  GRAC = 5,
  CLASS_IND = 6,
  ACB = 7,
}

export enum PlatformType {
  Console = 1,
  Arcade = 2,
  Platform = 3,
  OperatingSystem = 4,
  PortableConsole = 5,
  Computer = 6,
}

export enum GameStatus {
  Released = 0,
  Alpha = 2,
  Beta = 3,
  EarlyAccess = 4,
  Offline = 5,
  Cancelled = 6,
  Rumored = 7,
  Delisted = 8,
}

export enum GameType {
  MainGame = 0,
  DLC = 1,
  Expansion = 2,
  Bundle = 3,
  StandaloneExpansion = 4,
  Mod = 5,
  Episode = 6,
  Season = 7,
  Remake = 8,
  Remaster = 9,
  ExpandedEdition = 10,
  Port = 11,
  Fork = 12,
  PackAddon = 13,
  Update = 14,
}

export enum Region {
  Europe = 1,
  NorthAmerica = 2,
  Australia = 3,
  NewZealand = 4,
  Japan = 5,
  China = 6,
  Asia = 7,
  Worldwide = 8,
  Korea = 9,
  Brazil = 10,
}

export enum OrganizationRating {
  ESRB_RP = 1,
  ESRB_EC = 2,
  ESRB_E = 3,
  ESRB_E10 = 4,
  ESRB_T = 5,
  ESRB_M = 6,
  ESRB_AO = 7,

  PEGI_3 = 8,
  PEGI_7 = 9,
  PEGI_12 = 10,
  PEGI_16 = 11,
  PEGI_18 = 12,

  CERO_A = 13,
  CERO_B = 14,
  CERO_C = 15,
  CERO_D = 16,
  CERO_Z = 17,

  USK_0 = 18,
  USK_6 = 19,
  USK_12 = 20,
  USK_16 = 21,
  USK_18 = 22,

  GRAC_ALL = 23,
  GRAC_12 = 24,
  GRAC_15 = 25,
  GRAC_18 = 40,
  GRAC_19 = 26,

  CLASS_IND_L = 28,
  CLASS_IND_10 = 29,
  CLASS_IND_12 = 30,
  CLASS_IND_14 = 31,
  CLASS_IND_16 = 32,
  CLASS_IND_18 = 33,

  ACB_G = 34,
  ACB_PG = 35,
  ACB_M = 36,
  ACB_MA15 = 37,
  ACB_R18 = 38,
  ACB_RC = 39,
}

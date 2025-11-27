export {};

declare global {
  type ElectronLicenseStatus = {
    allowed: boolean;
    licensed: boolean;
    licenseOwner?: string;
    licenseExpiresAt?: string;
    expectedOwner?: string;
    identityEmail?: string | null;
    message?: string;
    trial?: {
      firstLaunchMs: number;
      expiresAt: string;
      daysTotal: number;
      daysLeft: number;
    };
  };

  type ElectronAuthDeepLinkPayload = {
    rawUrl: string;
    hash?: string;
    search?: string;
  };

  interface Window {
    electronAPI?: {
      net: {
        getStatus(): Promise<boolean>;
        onStatusChange(callback: (status: boolean) => void): () => void;
      };
      cache?: {
        getImagePath(key: string): Promise<string | null>;
        saveImage(key: string, data: ArrayBuffer | Uint8Array): Promise<string | null>;
        clear(): Promise<void>;
      };
      maps?: {
        getStatic(options: unknown): Promise<string | null>;
      };
      license?: {
        getStatus(): Promise<ElectronLicenseStatus | null>;
        activate(key: string): Promise<{ success: boolean; message: string }>;
        requestPrompt(): Promise<void>;
        purchase(): Promise<void>;
        setIdentity(identity: { email: string | null; userId?: string | null } | null): Promise<ElectronLicenseStatus | null>;
        getStoredKey(): Promise<string | null>;
        onStatus(callback: (status: ElectronLicenseStatus) => void): () => void;
        onPrompt(callback: () => void): () => void;
        onTrialWarning(callback: (status: ElectronLicenseStatus) => void): () => void;
      };
      chat?: {
        open(payload: string): void;
      };
      navigation?: {
        onOpenApp(callback: () => void): () => void;
        onLogout?(callback: () => void): () => void;
        onOpenSettings?(callback: () => void): () => void;
        onChangePassword?(callback: () => void): () => void;
      };
      auth?: {
        getPending(): Promise<ElectronAuthDeepLinkPayload | null>;
        acknowledge(): Promise<boolean>;
        onDeepLink(callback: (payload: ElectronAuthDeepLinkPayload) => void): () => void;
      };
      blocklist?: {
        open(): Promise<void>;
      };
      moderation?: never;
    };
  }
}

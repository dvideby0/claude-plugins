export interface CustomerProfile {
  id: string;
  displayName: string;
}

export function updateCustomerProfile(profile: CustomerProfile, name: string): CustomerProfile {
  return { ...profile, displayName: name };
}

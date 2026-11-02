/**
 * Hämtar en Auth0-access-token eller kastar. SDK:ns `getAccessTokenSilently` typas som
 * `string | undefined`; ett saknat token ska bli ett fel i anropet, aldrig en tom header.
 */
import { useAuth0 } from '@auth0/auth0-react';

export function useAccessToken(): () => Promise<string> {
  const { getAccessTokenSilently } = useAuth0();
  return async () => {
    const accessToken = await getAccessTokenSilently();
    if (accessToken === undefined) {
      throw new Error('Could not get an access token');
    }
    return accessToken;
  };
}

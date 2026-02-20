export const getUserId = (request: any) => {
  if (!request.user?.id) {
    const error = new Error('missing user context') as Error & { statusCode?: number };
    error.statusCode = 401;
    throw error;
  }
  return request.user.id;
};

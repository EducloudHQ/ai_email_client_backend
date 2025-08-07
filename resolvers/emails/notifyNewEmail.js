export const request = (ctx) => {
  return {};
};

export const response = (ctx) => {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  return ctx.args.email;
};

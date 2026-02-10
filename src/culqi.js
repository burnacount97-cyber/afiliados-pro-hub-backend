const getCulqiEnv = () => (process.env.CULQI_ENV || "live").toLowerCase();

export const getCulqiBaseUrl = () => {
  const env = getCulqiEnv();
  if (env === "test" || env === "sandbox") {
    return "https://api.culqi.com/v2";
  }
  return "https://api.culqi.com/v2";
};

const getCulqiSecretKey = () => {
  const key = process.env.CULQI_SECRET_KEY;
  if (!key) {
    throw new Error("Missing CULQI_SECRET_KEY");
  }
  return key;
};

export const createCulqiOrder = async (payload) => {
  const secretKey = getCulqiSecretKey();

  const response = await fetch(`${getCulqiBaseUrl()}/orders`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.user_message || data?.message || "Culqi error");
  }

  return data;
};

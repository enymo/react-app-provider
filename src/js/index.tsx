import { ResourceProvider, RouteFunction } from "@enymo/react-resource-hook";
import { SocketProvider } from "@enymo/react-socket-hook";
import { isNotNull, requireNotNull } from "@enymo/ts-nullsafe";
import globalAxios, { AxiosError, AxiosInstance } from "axios";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import semver from "semver";
import io from "socket.io-client";
import globalRoute, { Config } from "ziggy-js";

export default function createAppProvider<T extends {}>({
    whenLoading,
    whenNetworkDown,
    whenMaintenanceMode,
    whenNeedsUpdate,
    networkDownIsOverlay,
    baseUrl,
    stagingBaseUrl = baseUrl,
    useSocket = false,
    socketUrl = baseUrl,
    stagingSocketUrl = stagingBaseUrl,
    placeboUrl,
    placeboRetryInterval = 5000,
    installedVersion,
    initUrl,
    updateService,
    reactNative = false
}: {
    whenLoading?: React.ReactElement,
    whenNetworkDown?: React.ReactElement,
    whenMaintenanceMode?: React.ReactElement,
    whenNeedsUpdate?: React.ReactElement,
    networkDownIsOverlay?: boolean,
    baseUrl: string,
    stagingBaseUrl?: string,
    useSocket?: boolean,
    socketUrl?: string,
    stagingSocketUrl?: string,
    placeboUrl?: string,
    placeboRetryInterval?: number,
    installedVersion?: string,
    initUrl: string,
    updateService?(force: boolean): void | Promise<void>,
    reactNative?: boolean
}) {
    type ContextType = {
        axios: AxiosInstance,
        hasAuth: boolean,
        setAuth: (auth: string | null) => void,
        route: RouteFunction,
        staging: boolean,
        loading: boolean
    } & Partial<T>

    const Context = createContext<ContextType | null>(null);

    return {
        useApp: () => requireNotNull(useContext(Context), "AppProvider must be present in the component tree"),
        AppProvider: ({
            auth,
            onChangeAuth = () => {},
            children
        }: {
            auth?: string | null,
            onChangeAuth?(auth: string | null): void,
            children: React.ReactNode
        }) => {
            const [loading, setLoading] = useState(true);
            const [useStagingBackend, setUserStagingBackend] = useState(false);
            const [networkDown, setNetworkDown] = useState(false);
            const networkDownRef = useRef(false);
            const limbo = useRef<(() => void)[]>([]);
            const [ziggy, setZiggy] = useState<Config>();
            const [needsUpdate, setNeedsUpdate] = useState(false);
            const [maintenanceMode, setMaintenanceMode] = useState(false);
            const [extra, setExtra] = useState<T>();
            const initializing = useRef(false);
            
            const route = useCallback<RouteFunction>((route, params) => globalRoute(route, params, undefined, ziggy), [ziggy]);

            const handleSetNetworkDown = useCallback((networkDown: boolean) => {
                setNetworkDown(networkDown);
                networkDownRef.current = networkDown;
                if (!networkDown) {
                    for (const release of limbo.current) {
                        release();
                    }
                    limbo.current = [];
                }
            }, [setNetworkDown, networkDownRef, limbo]);

            const axios = useMemo(() => {
                const axios = globalAxios.create({
                    baseURL: useStagingBackend ? stagingBaseUrl : baseUrl,
                    headers: {
                        Authorization: auth && `Bearer ${auth}`
                    }
                });
                if (placeboUrl) {
                    axios.interceptors.request.use(config => {
                        if (networkDownRef.current && config.url !== placeboUrl) {
                            return new Promise(resolve =>{
                                limbo.current.push(() => resolve(config));
                            });
                        }
                        return config;
                    });
                    axios.interceptors.response.use(null, error => {
                        if (error instanceof AxiosError && !error.response) {
                            handleSetNetworkDown(true);
                            return axios.request(error.config!);
                        }
                        return Promise.reject(error);
                    });
                }
                return axios;
            }, [auth, useStagingBackend, handleSetNetworkDown]);

            const init = useCallback(async () => {
                initializing.current = true;
                try {
                    const {current_version, recommended_version, minimum_version, ziggy, ...extra} = (await axios.get<{
                        current_version?: string,
                        recommended_version?: string,
                        minimum_version?: string,
                        ziggy?: Config
                    } & T>(initUrl)).data;
                    setMaintenanceMode(false);
                    if (installedVersion && current_version && semver.gt(installedVersion, current_version) && !useStagingBackend) {
                        setUserStagingBackend(true);
                    }
                    else {
                        setZiggy(ziggy);
                        setExtra(extra as T);
                        const needsUpdate = isNotNull(installedVersion) && isNotNull(minimum_version) && semver.gt(minimum_version, installedVersion);
                        const shouldUpdate = isNotNull(installedVersion) && isNotNull(recommended_version) && semver.gt(recommended_version, installedVersion);
                        setNeedsUpdate(needsUpdate);
                        if (shouldUpdate) {
                            await updateService?.(needsUpdate);
                        }
                        setLoading(false);
                    }
                }
                catch (e) {
                    if (e instanceof AxiosError && e.response?.status === 503) {
                        setMaintenanceMode(true);
                        setTimeout(init, 10000);
                    }
                    else {
                        throw e;
                    }
                }
            }, [axios, useStagingBackend, setUserStagingBackend, setZiggy, setLoading, setMaintenanceMode, setExtra, initializing]);

            const socket = useMemo(() => {
                if (useSocket && auth !== undefined) {
                    const socket = io(useStagingBackend ? stagingSocketUrl : socketUrl, {
                        auth: auth ? {
                            token: auth
                        } : undefined
                    });
                    socket.on("connect_error", () => handleSetNetworkDown(true));
                    return socket;
                }
                return null;
            }, [auth, handleSetNetworkDown]);

            useEffect(() => {
                if (networkDown && placeboUrl) {
                    const interval = setInterval(async () => {
                        try {
                            await axios.get(placeboUrl);
                            handleSetNetworkDown(false);
                        }
                        catch (e) {
                            if (!(e instanceof AxiosError)) {
                                throw e;
                            }
                        }
                    }, placeboRetryInterval);
                    return () => clearInterval(interval);
                }
            }, [networkDown, handleSetNetworkDown]);

            useEffect(() => {
                if (auth !== undefined && !initializing.current) {
                    init();
                }
            }, [auth, initializing, init]);

            if (networkDown && !networkDownIsOverlay) {
                return networkDown;
            }

            if (whenMaintenanceMode && maintenanceMode) {
                return whenMaintenanceMode;
            }

            if (loading && whenLoading) {
                return <>
                    {whenLoading}
                    {networkDown && whenNetworkDown}
                </>
            }

            if (needsUpdate && whenNeedsUpdate) {
                return whenNeedsUpdate;
            }

            return (
                <SocketProvider value={socket}>
                    <ResourceProvider value={{axios, routeFunction: route, reactNative}}>
                        <Context.Provider value={{
                            axios,
                            hasAuth: isNotNull(auth),
                            route,
                            loading,
                            setAuth: onChangeAuth,
                            staging: useStagingBackend,
                            ...extra
                        } as ContextType}>
                            {children}
                        </Context.Provider>
                    </ResourceProvider>
                </SocketProvider>
            )
        }
    }
}
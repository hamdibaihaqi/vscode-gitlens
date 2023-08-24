import type { Container } from '../../container';
import type { PagedResult } from '../../git/gitProvider';
import { Logger } from '../../system/logger';
import type {
	GetIssuesOptions,
	GetPullRequestsOptions,
	PagedProjectInput,
	PagedRepoInput,
	ProviderAccount,
	ProviderIssue,
	ProviderPullRequest,
	ProviderRepoInput,
	ProviderReposInput,
	ProviderRepository,
} from './models';
import { IssueFilter, PagingMode, ProviderId, PullRequestFilter } from './models';
import { ProvidersApi } from './providersApi';

export class ProvidersService {
	private _providersApi: ProvidersApi;

	constructor(private readonly container: Container) {
		this._providersApi = new ProvidersApi(this.container);
	}

	async ensureSession(providerId: ProviderId): Promise<boolean> {
		const session = await this.container.integrationAuthentication.getSession(
			providerId,
			{
				domain: this._providersApi.getProviderDomain(providerId) ?? '',
				scopes: this._providersApi.getScopesForProvider(providerId) ?? [],
			},
			{ createIfNeeded: true },
		);

		return session != null;
	}

	async getPullRequestsForRepos(
		providerId: ProviderId,
		reposOrRepoIds: ProviderReposInput,
		options?: {
			filters?: PullRequestFilter[];
			cursor?: string;
		},
	): Promise<PagedResult<ProviderPullRequest> | undefined> {
		if (!(await this.ensureSession(providerId))) return undefined;
		if (
			providerId !== ProviderId.GitLab &&
			(this._providersApi.isRepoIdsInput(reposOrRepoIds) ||
				(providerId === ProviderId.AzureDevOps &&
					!reposOrRepoIds.every(repo => repo.project != null && repo.namespace != null)))
		) {
			Logger.warn(`Unsupported input for provider ${providerId}`);
			return undefined;
		}

		let getPullRequestsOptions: GetPullRequestsOptions | undefined;
		if (options?.filters != null) {
			if (!this._providersApi.providerSupportsPullRequestFilters(providerId, options.filters)) {
				Logger.warn(`Unsupported filters for provider ${providerId}`, 'getPullRequestsForRepos');
				return undefined;
			}

			let userAccount: ProviderAccount | undefined;
			if (providerId === ProviderId.AzureDevOps) {
				const organizations = new Set<string>();
				for (const repo of reposOrRepoIds as ProviderRepoInput[]) {
					organizations.add(repo.namespace);
				}

				if (organizations.size > 1) {
					Logger.warn(
						`Multiple organizations not supported for provider ${providerId}`,
						'getPullRequestsForRepos',
					);
					return undefined;
				} else if (organizations.size === 0) {
					Logger.warn(`No organizations found for provider ${providerId}`, 'getPullRequestsForRepos');
					return undefined;
				}

				const organization: string = organizations.values().next().value;
				try {
					userAccount = await this._providersApi.getCurrentUserForInstance(providerId, organization);
				} catch (ex) {
					Logger.error(ex, 'getPullRequestsForRepos');
					return undefined;
				}
			} else {
				try {
					userAccount = await this._providersApi.getCurrentUser(providerId);
				} catch (ex) {
					Logger.error(ex, 'getPullRequestsForRepos');
					return undefined;
				}
			}

			if (userAccount == null) {
				Logger.warn(`Unable to get current user for ${providerId}`, 'getPullRequestsForRepos');
				return undefined;
			}

			let userFilterProperty: string | null;
			switch (providerId) {
				case ProviderId.Bitbucket:
				case ProviderId.AzureDevOps:
					userFilterProperty = userAccount.id;
					break;
				default:
					userFilterProperty = userAccount.username;
					break;
			}

			if (userFilterProperty == null) {
				Logger.warn(`Unable to get user property for filter for ${providerId}`, 'getPullRequestsForRepos');
				return undefined;
			}

			getPullRequestsOptions = {
				authorLogin: options.filters.includes(PullRequestFilter.Author) ? userFilterProperty : undefined,
				assigneeLogins: options.filters.includes(PullRequestFilter.Assignee) ? [userFilterProperty] : undefined,
				reviewRequestedLogin: options.filters.includes(PullRequestFilter.ReviewRequested)
					? userFilterProperty
					: undefined,
				mentionLogin: options.filters.includes(PullRequestFilter.Mention) ? userFilterProperty : undefined,
			};
		}

		if (
			this._providersApi.getProviderPullRequestsPagingMode(providerId) === PagingMode.Repo &&
			!this._providersApi.isRepoIdsInput(reposOrRepoIds)
		) {
			const cursorInfo = JSON.parse(options?.cursor ?? '{}');
			const cursors: PagedRepoInput[] = cursorInfo.cursors ?? [];
			let repoInputs: PagedRepoInput[] = reposOrRepoIds.map(repo => ({ repo: repo, cursor: undefined }));
			if (cursors.length > 0) {
				repoInputs = cursors;
			}

			try {
				const cursor: { cursors: PagedRepoInput[] } = { cursors: [] };
				let hasMore = false;
				const data: ProviderPullRequest[] = [];
				await Promise.all(
					repoInputs.map(async repoInput => {
						const results = await this._providersApi.getPullRequestsForRepo(providerId, repoInput.repo, {
							...getPullRequestsOptions,
							cursor: repoInput.cursor,
						});
						data.push(...results.values);
						if (results.paging?.more) {
							hasMore = true;
							cursor.cursors.push({ repo: repoInput.repo, cursor: results.paging.cursor });
						}
					}),
				);

				return {
					values: data,
					paging: {
						more: hasMore,
						cursor: JSON.stringify(cursor),
					},
				};
			} catch (ex) {
				Logger.error(ex, 'getPullRequestsForRepos');
				return undefined;
			}
		}

		try {
			return await this._providersApi.getPullRequestsForRepos(providerId, reposOrRepoIds, {
				...getPullRequestsOptions,
				cursor: options?.cursor,
			});
		} catch (ex) {
			Logger.error(ex, 'getPullRequestsForRepos');
			return undefined;
		}
	}

	async getIssuesForRepos(
		providerId: ProviderId,
		reposOrRepoIds: ProviderReposInput,
		options?: {
			filters?: IssueFilter[];
			cursor?: string;
		},
	): Promise<PagedResult<ProviderIssue> | undefined> {
		if (!(await this.ensureSession(providerId))) return undefined;
		if (
			providerId !== ProviderId.GitLab &&
			(this._providersApi.isRepoIdsInput(reposOrRepoIds) ||
				(providerId === ProviderId.AzureDevOps &&
					!reposOrRepoIds.every(repo => repo.project != null && repo.namespace != null)))
		) {
			Logger.warn(`Unsupported input for provider ${providerId}`, 'getIssuesForRepos');
			return undefined;
		}

		let getIssuesOptions: GetIssuesOptions | undefined;
		if (providerId === ProviderId.AzureDevOps) {
			const organizations = new Set<string>();
			const projects = new Set<string>();
			for (const repo of reposOrRepoIds as ProviderRepoInput[]) {
				organizations.add(repo.namespace);
				projects.add(repo.project!);
			}

			if (organizations.size > 1) {
				Logger.warn(`Multiple organizations not supported for provider ${providerId}`, 'getIssuesForRepos');
				return undefined;
			} else if (organizations.size === 0) {
				Logger.warn(`No organizations found for provider ${providerId}`, 'getIssuesForRepos');
				return undefined;
			}

			const organization: string = organizations.values().next().value;

			if (options?.filters != null) {
				if (!this._providersApi.providerSupportsIssueFilters(providerId, options.filters)) {
					Logger.warn(`Unsupported filters for provider ${providerId}`, 'getIssuesForRepos');
					return undefined;
				}

				let userAccount: ProviderAccount | undefined;
				try {
					userAccount = await this._providersApi.getCurrentUserForInstance(providerId, organization);
				} catch (ex) {
					Logger.error(ex, 'getIssuesForRepos');
					return undefined;
				}

				if (userAccount == null) {
					Logger.warn(`Unable to get current user for ${providerId}`, 'getIssuesForRepos');
					return undefined;
				}

				const userFilterProperty = userAccount.name;

				if (userFilterProperty == null) {
					Logger.warn(`Unable to get user property for filter for ${providerId}`, 'getIssuesForRepos');
					return undefined;
				}

				getIssuesOptions = {
					authorLogin: options.filters.includes(IssueFilter.Author) ? userFilterProperty : undefined,
					assigneeLogins: options.filters.includes(IssueFilter.Assignee) ? [userFilterProperty] : undefined,
					mentionLogin: options.filters.includes(IssueFilter.Mention) ? userFilterProperty : undefined,
				};
			}

			const cursorInfo = JSON.parse(options?.cursor ?? '{}');
			const cursors: PagedProjectInput[] = cursorInfo.cursors ?? [];
			let projectInputs: PagedProjectInput[] = Array.from(projects.values()).map(project => ({
				namespace: organization,
				project: project,
				cursor: undefined,
			}));
			if (cursors.length > 0) {
				projectInputs = cursors;
			}

			try {
				const cursor: { cursors: PagedProjectInput[] } = { cursors: [] };
				let hasMore = false;
				const data: ProviderIssue[] = [];
				await Promise.all(
					projectInputs.map(async projectInput => {
						const results = await this._providersApi.getIssuesForAzureProject(
							projectInput.namespace,
							projectInput.project,
							{
								...getIssuesOptions,
								cursor: projectInput.cursor,
							},
						);
						data.push(...results.values);
						if (results.paging?.more) {
							hasMore = true;
							cursor.cursors.push({
								namespace: projectInput.namespace,
								project: projectInput.project,
								cursor: results.paging.cursor,
							});
						}
					}),
				);

				return {
					values: data,
					paging: {
						more: hasMore,
						cursor: JSON.stringify(cursor),
					},
				};
			} catch (ex) {
				Logger.error(ex, 'getIssuesForRepos');
				return undefined;
			}
		}
		if (options?.filters != null) {
			let userAccount: ProviderAccount | undefined;
			try {
				userAccount = await this._providersApi.getCurrentUser(providerId);
			} catch (ex) {
				Logger.error(ex, 'getIssuesForRepos');
				return undefined;
			}

			if (userAccount == null) {
				Logger.warn(`Unable to get current user for ${providerId}`, 'getIssuesForRepos');
				return undefined;
			}

			const userFilterProperty = userAccount.username;
			if (userFilterProperty == null) {
				Logger.warn(`Unable to get user property for filter for ${providerId}`, 'getIssuesForRepos');
				return undefined;
			}

			getIssuesOptions = {
				authorLogin: options.filters.includes(IssueFilter.Author) ? userFilterProperty : undefined,
				assigneeLogins: options.filters.includes(IssueFilter.Assignee) ? [userFilterProperty] : undefined,
				mentionLogin: options.filters.includes(IssueFilter.Mention) ? userFilterProperty : undefined,
			};
		}

		if (
			this._providersApi.getProviderIssuesPagingMode(providerId) === PagingMode.Repo &&
			!this._providersApi.isRepoIdsInput(reposOrRepoIds)
		) {
			const cursorInfo = JSON.parse(options?.cursor ?? '{}');
			const cursors: PagedRepoInput[] = cursorInfo.cursors ?? [];
			let repoInputs: PagedRepoInput[] = reposOrRepoIds.map(repo => ({ repo: repo, cursor: undefined }));
			if (cursors.length > 0) {
				repoInputs = cursors;
			}

			try {
				const cursor: { cursors: PagedRepoInput[] } = { cursors: [] };
				let hasMore = false;
				const data: ProviderIssue[] = [];
				await Promise.all(
					repoInputs.map(async repoInput => {
						const results = await this._providersApi.getIssuesForRepo(providerId, repoInput.repo, {
							...getIssuesOptions,
							cursor: repoInput.cursor,
						});
						data.push(...results.values);
						if (results.paging?.more) {
							hasMore = true;
							cursor.cursors.push({ repo: repoInput.repo, cursor: results.paging.cursor });
						}
					}),
				);

				return {
					values: data,
					paging: {
						more: hasMore,
						cursor: JSON.stringify(cursor),
					},
				};
			} catch (ex) {
				Logger.error(ex, 'getIssuesForRepos');
				return undefined;
			}
		}

		try {
			return await this._providersApi.getIssuesForRepos(providerId, reposOrRepoIds, {
				...getIssuesOptions,
				cursor: options?.cursor,
			});
		} catch (ex) {
			Logger.error(ex, 'getIssuesForRepos');
			return undefined;
		}
	}

	async getReposForAzureProject(
		namespace: string,
		project: string,
		options?: { cursor?: string },
	): Promise<PagedResult<ProviderRepository> | undefined> {
		if (!(await this.ensureSession(ProviderId.AzureDevOps))) return undefined;
		try {
			return await this._providersApi.getReposForAzureProject(namespace, project, { cursor: options?.cursor });
		} catch (ex) {
			Logger.error(ex, 'getReposForAzureProject');
			return undefined;
		}
	}
}

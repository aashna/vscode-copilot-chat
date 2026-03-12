/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RequestType } from '@vscode/copilot-api';
import { Codicon } from '../../../util/vs/base/common/codicons';
import { IAuthenticationService } from '../../authentication/common/authentication';
import { ILogService } from '../../log/common/logService';
import { Response } from '../../networking/common/fetcherService';
import { IRequestLogger, LoggedRequestKind } from '../../requestLogger/node/requestLogger';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { ICAPIClientService } from '../common/capiClient';

/**
 * Per-dimension capability requirement scores from the HYDRA multi-head model.
 * Each value is in [0, 1] representing how much of that capability the query requires.
 * Only present when the server is running the HYDRA model (MODEL_TYPE=hydra).
 */
export interface HydraScores {
	reasoning?: number;
	code_gen?: number;
	debugging?: number;
	tool_use?: number;
}

export interface RouterDecisionResponse {
	predicted_label: 'needs_reasoning' | 'no_reasoning';
	confidence: number;
	latency_ms: number;
	/** The router's top pick — the single model the client should use. */
	chosen_model: string;
	candidate_models: string[];
	scores: {
		needs_reasoning: number;
		no_reasoning: number;
	};
	sticky_override?: boolean;
	/** Per-dimension HYDRA scores. Only present when server uses HYDRA model. */
	hydra_scores?: HydraScores;
	/** Routing method used: "binary" or "hydra". */
	routing_method?: string;
}

export interface RoutingContextSignals {
	turn_number?: number;
	session_id?: string;
	previous_model?: string;
	reference_count?: number;
	prompt_char_count?: number;
}

/**
 * Fetches routing decisions from a classification API to determine which model should handle a query.
 *
 * This class sends queries along with available models to a router API endpoint, which uses
 * ML-based classification to select the most appropriate model based on the query's requirements.
 *
 * When the server runs the HYDRA multi-head model, the response includes per-dimension
 * capability scores (reasoning, code_gen, debugging, tool_use) and uses capability-based
 * matching instead of binary type filtering.
 */
export class RouterDecisionFetcher {
	constructor(
		private readonly _capiClientService: ICAPIClientService,
		private readonly _authService: IAuthenticationService,
		private readonly _logService: ILogService,
		private readonly _telemetryService: ITelemetryService,
		private readonly _requestLogger: IRequestLogger,
	) {
	}

	async getRouterDecision(query: string, autoModeToken: string, availableModels: string[], stickyThreshold?: number, contextSignals?: RoutingContextSignals): Promise<RouterDecisionResponse> {
		const startTime = Date.now();
		const requestBody: Record<string, unknown> = { prompt: query, available_models: availableModels, ...contextSignals };
		if (stickyThreshold !== undefined) {
			requestBody.sticky_threshold = stickyThreshold;
		}
		const response = await this._capiClientService.makeRequest<Response>({
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${(await this._authService.getCopilotToken()).token}`,
				'Copilot-Session-Token': autoModeToken,
			},
			body: JSON.stringify(requestBody)
		}, { type: RequestType.ModelRouter });

		if (!response.ok) {
			throw new Error(`Router decision request failed with status ${response.status}: ${response.statusText}`);
		}

		const text = await response.text();
		const result: RouterDecisionResponse = JSON.parse(text);
		const e2eLatencyMs = Date.now() - startTime;

		// Build trace log with HYDRA scores if present
		const hydraInfo = result.hydra_scores
			? `, hydra_scores: {reasoning=${result.hydra_scores.reasoning?.toFixed(2)}, code_gen=${result.hydra_scores.code_gen?.toFixed(2)}, debugging=${result.hydra_scores.debugging?.toFixed(2)}, tool_use=${result.hydra_scores.tool_use?.toFixed(2)}}`
			: '';
		this._logService.trace(`[RouterDecisionFetcher] Prediction: ${result.predicted_label}, chosen_model: ${result.chosen_model}, (confidence: ${(result.confidence * 100).toFixed(1)}%, routing_method: ${result.routing_method ?? 'binary'}, scores: needs_reasoning=${(result.scores.needs_reasoning * 100).toFixed(1)}%, no_reasoning=${(result.scores.no_reasoning * 100).toFixed(1)}%${hydraInfo}) (latency_ms: ${result.latency_ms}, e2e_latency_ms: ${e2eLatencyMs}, candidate models: ${result.candidate_models.join(', ')}, sticky_override: ${result.sticky_override ?? false})`);

		// Build markdown content for request logger
		const markdownSections = [
			`# Auto Mode Router Decision`,
			`## Result`,
			`- **Chosen Model**: ${result.chosen_model}`,
			`- **Predicted Label**: ${result.predicted_label}`,
			`- **Confidence**: ${(result.confidence * 100).toFixed(1)}%`,
			`- **Routing Method**: ${result.routing_method ?? 'binary'}`,
			`- **Sticky Override**: ${result.sticky_override ?? false}`,
			`## Scores`,
			`- **Needs Reasoning**: ${(result.scores.needs_reasoning * 100).toFixed(1)}%`,
			`- **No Reasoning**: ${(result.scores.no_reasoning * 100).toFixed(1)}%`,
		];

		// Add HYDRA dimension scores if present
		if (result.hydra_scores) {
			markdownSections.push(
				`## HYDRA Capability Scores`,
				`| Dimension | Score |`,
				`|-----------|-------|`,
				`| Reasoning | ${((result.hydra_scores.reasoning ?? 0) * 100).toFixed(1)}% |`,
				`| Code Gen | ${((result.hydra_scores.code_gen ?? 0) * 100).toFixed(1)}% |`,
				`| Debugging | ${((result.hydra_scores.debugging ?? 0) * 100).toFixed(1)}% |`,
				`| Tool Use | ${((result.hydra_scores.tool_use ?? 0) * 100).toFixed(1)}% |`,
			);
		}

		markdownSections.push(
			`## Latency`,
			`- **Router Latency**: ${result.latency_ms}ms`,
			`- **E2E Latency**: ${e2eLatencyMs}ms`,
			`## Candidate Models`,
			...result.candidate_models.map(m => `- ${m}`),
			`## Query`,
			query,
		);

		this._requestLogger.addEntry({
			type: LoggedRequestKind.MarkdownContentRequest,
			debugName: `Auto Mode Router`,
			startTimeMs: startTime,
			icon: Codicon.lightbulbSparkle,
			markdownContent: markdownSections.join('\n'),
		});

		/* __GDPR__
			"automode.routerDecision" : {
				"owner": "lramos15",
				"comment": "Reports the routing decision made by the auto mode router API",
				"predictedLabel": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The predicted classification label (needs_reasoning or no_reasoning)" },
				"routingMethod": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "comment": "The routing method used: binary or hydra" },
				"confidence": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "The confidence score of the routing decision" },
				"latencyMs": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true, "comment": "The latency of the router API call in milliseconds" },
				"e2eLatencyMs": { "classification": "SystemMetaData", "purpose": "PerformanceAndHealth", "isMeasurement": true, "comment": "The end-to-end latency of the router request in milliseconds, including network overhead" },
				"hydraReasoning": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "HYDRA reasoning dimension score (0-1), only set when hydra model is active" },
				"hydraCodeGen": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "HYDRA code_gen dimension score (0-1), only set when hydra model is active" },
				"hydraDebugging": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "HYDRA debugging dimension score (0-1), only set when hydra model is active" },
				"hydraToolUse": { "classification": "SystemMetaData", "purpose": "FeatureInsight", "isMeasurement": true, "comment": "HYDRA tool_use dimension score (0-1), only set when hydra model is active" }
			}
		*/
		const measurements: Record<string, number> = {
			confidence: result.confidence,
			latencyMs: result.latency_ms,
			e2eLatencyMs: e2eLatencyMs,
		};
		if (result.hydra_scores) {
			if (result.hydra_scores.reasoning !== undefined) { measurements.hydraReasoning = result.hydra_scores.reasoning; }
			if (result.hydra_scores.code_gen !== undefined) { measurements.hydraCodeGen = result.hydra_scores.code_gen; }
			if (result.hydra_scores.debugging !== undefined) { measurements.hydraDebugging = result.hydra_scores.debugging; }
			if (result.hydra_scores.tool_use !== undefined) { measurements.hydraToolUse = result.hydra_scores.tool_use; }
		}

		this._telemetryService.sendMSFTTelemetryEvent('automode.routerDecision',
			{
				predictedLabel: result.predicted_label,
				routingMethod: result.routing_method ?? 'binary',
			},
			measurements
		);
		return result;
	}
}

function exportForViz(varargin)
% exportForViz([options])
%
% Exports precomputed data for the three.js visualization layer (Tier 1,
% see LLM_context/VISUALIZATION_PLAN.md, Sections 3 & 8). For each
% (stiffness, rotation axis) combination, runs the existing sensing
% pipeline -- Euler-Lagrange strain simulation, neural encoding, spike
% generation, SSPOC -- and writes manifest.json plus one set_<id>.json per
% combination into public/data/, matching the schema in Section 3 of the
% plan.
%
% Run from the repo root (optimal_sensing_ELwing/), the same working
% directory convention as wing_sensors_main.m, e.g.:
%
%   >> cd visualization/export
%   >> exportForViz()                    % Phase 0: one quick set (yaw, E=1)
%   >> exportForViz('quick', false)      % Phase 5: full Medium grid
%
% Requires the cvx package on the MATLAB path (see README.md), same as
% wing_sensors_main.m / sspocOptim.m.
%
% Options (name-value pairs):
%   'quick'             (default true)   Phase-0 mode: exports exactly one
%                                        set (yaw axis, stiffness factor 1)
%                                        at reduced time resolution, for a
%                                        fast end-to-end schema check. This
%                                        output is NOT scientifically valid
%                                        (too few wingbeats, reduced spike
%                                        timing precision) -- it exists only
%                                        to validate the export pipeline and
%                                        JSON schema. Set false for the real
%                                        Medium grid sweep (Phase 5).
%   'stiffnessFactors'  Vector of stiffness factors (1 = 3 GPa, the paper's
%                       hawkmoth reference value). Default: [1] in quick
%                       mode; a 10-point Medium grid otherwise (denser near
%                       factor 1 and the low-stiffness accuracy peak, per
%                       Section 4 of the plan). Values below ~0.23 (0.7 GPa)
%                       are rejected -- the Euler-Lagrange model does not
%                       converge there (see eulerLagrange.m / paper Methods).
%   'axes'              Cell array of {'yaw','pitch','roll'}. Default:
%                       {'yaw'} in quick mode; all three otherwise.
%   'outDir'            Output directory. Default: public/data alongside
%                       this export/ folder.
%   'nFrames'           Frames per representative wingbeat exported for the
%                       3D animation loop. Default: 90.
%
% See also: eulerLagrange, neuralTransformationOfData,
%   convertProbFiringToSpikes, dimReductionForSspoc, sspocOptim,
%   classAccuracyLin, wing_sensors_main (the pipeline template this script
%   mirrors).

p = inputParser;
addParameter(p, 'quick', true);
addParameter(p, 'stiffnessFactors', []);
addParameter(p, 'axes', {});
addParameter(p, 'outDir', fullfile(fileparts(mfilename('fullpath')), '..', 'public', 'data'));
addParameter(p, 'nFrames', 90);
parse(p, varargin{:});
opt = p.Results;

if isempty(opt.stiffnessFactors)
    if opt.quick
        opt.stiffnessFactors = 1;
    else
        % Medium grid (~10 points), denser near stiffness factor 1 and the
        % low-stiffness accuracy peak (paper Figs 2-3). Floor of 0.23
        % (0.7 GPa) matches the Euler-Lagrange convergence limit.
        opt.stiffnessFactors = [0.23 0.35 0.5 0.7 0.85 1.0 1.15 1.4 2.0 3.3];
    end
end
if any(opt.stiffnessFactors < 0.7/3)
    error('exportForViz:stiffnessTooLow', ...
        ['Stiffness factor(s) below ~0.23 (0.7 GPa) requested. The Euler-Lagrange ' ...
         'model does not converge below 0.7 GPa (see eulerLagrange.m / paper Methods).']);
end
if isempty(opt.axes)
    if opt.quick
        opt.axes = {'yaw'};
    else
        opt.axes = {'yaw', 'pitch', 'roll'};
    end
end

if ~exist(opt.outDir, 'dir')
    mkdir(opt.outDir);
end

manifest = struct();
manifest.grid = struct('chordElements', 26, 'spanElements', 51, 'chord_mm', 25, 'span_mm', 50);
manifest.sets = {};
manifest.quick = opt.quick;

% Built from the SAME effective Pars (quick-mode override applied) used for
% every set below -- staFilt must match whatever sampFreq the exported
% strain arrays were actually generated at, or the JS re-encoding
% (encoding.js, Phase 2) would reconvolve a filter built for the wrong time
% resolution against the data.
templatePars = applyQuickOverride(makeParameterStruct(), opt);
manifest.encoding = encodingConstants(templatePars);

setIdx = 0;
for iStiff = 1:length(opt.stiffnessFactors)
    for iAxis = 1:length(opt.axes)
        setIdx = setIdx + 1;
        sf = opt.stiffnessFactors(iStiff);
        axisName = opt.axes{iAxis};
        setId = sprintf('E%.2f_%s', sf, axisName);
        fprintf('[%d/%d] exporting %s ...\n', setIdx, length(opt.stiffnessFactors)*length(opt.axes), setId);

        result = exportOneSet(sf, axisName, opt);

        setFile = sprintf('set_%s.json', setId);
        writeJSON(fullfile(opt.outDir, setFile), result.payload);

        manifest.sets{end+1} = struct( ...
            'id', setId, ...
            'stiffnessFactor', sf, ...
            'axis', axisName, ...
            'accuracy', result.accuracy, ...
            'file', setFile);
    end
end

writeJSON(fullfile(opt.outDir, 'manifest.json'), manifest);
fprintf('Done. Wrote %d set(s) + manifest.json to %s\n', setIdx, opt.outDir);
if opt.quick
    fprintf(['NOTE: quick mode output is for schema validation only -- it is NOT ' ...
        'scientifically valid data. Run exportForViz(''quick'', false) for the real export.\n']);
end

end


function result = exportOneSet(stiffnessFactor, axisName, opt)
% Runs the full pipeline for one (stiffness, axis) combination and returns
% a struct with the JSON-ready payload and its summary accuracy.

Pars = makeParameterStruct();
Pars.E = stiffnessFactor * 3e7;
Pars = applyQuickOverride(Pars, opt);

Pars.rollRots  = [0 0];
Pars.pitchRots = [0 0];
Pars.yawRots   = [0 0];
switch axisName
    case 'yaw'
        Pars.yawRots = [0 10];
    case 'pitch'
        Pars.pitchRots = [0 10];
    case 'roll'
        Pars.rollRots = [0 10];
    otherwise
        error('exportForViz:badAxis', 'unknown axis "%s" (expected yaw/pitch/roll)', axisName);
end

conditions = {'flap', 'rotate'};
raw = struct();
StrainSet = struct();
for c = 1:2
    fprintf('  [%s / E=%.2f] simulating %s condition...\n', axisName, stiffnessFactor, conditions{c});
    [strain, deform] = simulateConditionWithDeform( ...
        Pars.rollRots(c), Pars.pitchRots(c), Pars.yawRots(c), ...
        Pars.phi_dist(c), Pars.theta_dist(c), Pars.psi_dist(c), Pars);
    raw.(conditions{c}).strain = strain;   % nSensorLocs x nTimePts
    raw.(conditions{c}).deform = deform;   % nTimePts x chordElements x spanElements

    fieldName = rotFieldName(Pars.rollRots(c), Pars.pitchRots(c), Pars.yawRots(c));
    StrainSet.(fieldName) = strain;
end

% --- neural encoding -> spikes -> dim reduction -> SSPOC.
% Identical steps to wing_sensors_main.m, reusing the pipeline functions
% unmodified so any edit to those .m files is picked up automatically.
[X_ne, G_ne] = neuralTransformationOfData(StrainSet, Pars);

timePtsPerSpikeRep = size(X_ne,2)/(Pars.sampFreq / Pars.flapFrequency) - length(unique(G_ne));
X = zeros(size(X_ne,1), timePtsPerSpikeRep*Pars.spikeReps);
G = zeros(1, timePtsPerSpikeRep*Pars.spikeReps);
for spRep = 1:Pars.spikeReps
    thisRepIdx = (spRep-1)*timePtsPerSpikeRep+1 : spRep*timePtsPerSpikeRep;
    [X(:,thisRepIdx), G(thisRepIdx), ~] = convertProbFiringToSpikes(X_ne, G_ne, Pars);
end

[X, G, XTest, GTest] = trainTestSplit(X, G, Pars);

Xmean = mean(X,2);
Xstd = std(X,[],2);
Xstd(Xstd<1e-14) = 1;
XNorm = (X-Xmean)./repmat(Xstd,1,size(X,2));
[w_t, Psi] = dimReductionForSspoc(XNorm, G, Pars);

[sensors, ~, s] = sspocOptim(w_t, Psi, Pars, length(unique(G)));
[~, I_top] = sort(sum(abs(s),2), 'descend');
sensorsSort = I_top(1:Pars.rmodes);
if length(sensors) < 5
    sensors = sensorsSort(1:5); %#ok<NASGU> % kept for parity with wing_sensors_main.m; unused below
end
sensors10 = sensorsSort(1:10);

% Accuracy for every sensor count 1-10, so the front-end's client-side
% sensor-count slider (Plan Section 7) can show accuracy for any count
% instantly, with no backend round trip.
accBySensorCount = zeros(1, 10);
for n = 1:10
    accBySensorCount(n) = classAccuracyLin(X, G, XTest, GTest, sensorsSort(1:n));
end
accAll = classAccuracyLin(X, G, XTest, GTest, 1:size(X,1));

% --- representative wingbeat window: one period, taken by exact index
% (not interpolation) so `strain` stays bit-consistent with the filter in
% manifest.encoding. Window starts one full period after simStartup (an
% extra discarded wingbeat, matching convertProbFiringToSpikes.m's own
% convention of dropping the first wingbeat of each condition for the same
% reason: simulation artifacts near the sigmoidal startup transient).
%
% Two different resolutions are shipped, deliberately:
%   - `deform` is downsampled to opt.nFrames (default 90) -- coarse is
%     visually fine for the 3D animation loop and keeps that payload small.
%   - `strain` is shipped at NATIVE resolution (Pars.sampFreq), i.e. NOT
%     downsampled -- encoding.js (Phase 2) needs enough time resolution to
%     reconvolve manifest.encoding.staFilt accurately; 90 samples/wingbeat
%     would be far too coarse for that (in full/non-quick mode, native
%     resolution is 400 samples/wingbeat at sampFreq=1e4). This makes
%     `strain` the dominant contributor to per-set size -- see README.md
%     for the resulting size implications versus the plan's original
%     estimate.
period_s = 1/Pars.flapFrequency;
nativeStepsPerPeriod = round(period_s * Pars.sampFreq);
iStart = round(Pars.simStartup*Pars.sampFreq) + 1 + nativeStepsPerPeriod;
iEnd   = iStart + nativeStepsPerPeriod - 1;
totalTimePts = round(Pars.simEnd*Pars.sampFreq);
if iEnd > totalTimePts
    error('exportForViz:windowTooLong', ...
        ['Pars.simEnd (%.3fs, %d time points) is too short for a full representative ' ...
         'wingbeat window ending at index %d; increase simEnd.'], ...
        Pars.simEnd, totalTimePts, iEnd);
end

% `strain` additionally needs a lead-in before iStart: encoding.js (Phase 2)
% must convolve it with manifest.encoding.staFilt using MATLAB's `conv(x,
% staFilt,'valid')` semantics, which needs (filterTaps-1) samples of
% history before the first output point to produce a full-length,
% non-truncated result covering the whole displayed wingbeat -- exactly
% the same reason neuralTransformationOfData.m runs the convolution over
% the full continuous simulation rather than an isolated window. Without
% this, the first ~(filterTaps-1) samples of P(fire) would be wrong or
% would have to be dropped.
enc = encodingConstants(Pars);
leadInSamples = numel(enc.staFilt) - 1;
strainStart = iStart - leadInSamples;
if strainStart < 1
    error('exportForViz:leadInTooLong', ...
        ['Not enough simulated time before the display window for the filter ' ...
         'lead-in (%d samples needed, window starts at index %d). Increase ' ...
         'Pars.simStartup.'], leadInSamples, iStart);
end

animFrameIdx = round(linspace(iStart, iEnd, opt.nFrames + 1));
animFrameIdx(end) = [];  % last frame loops back into the first frame; avoid duplicate

payload = struct();
payload.frames = opt.nFrames;               % deform (animation) resolution
payload.strainFrames = nativeStepsPerPeriod; % strain DISPLAY resolution (post-convolution length)
payload.strainLeadInFrames = leadInSamples;  % extra samples prepended to strain, for valid convolution
payload.period_ms = period_s * 1000;
payload.conditions = struct();
for c = 1:2
    cond = conditions{c};

    deform_c = raw.(cond).deform;   % nTime x chordElements x spanElements
    payload.conditions.(cond).deform = single(deform_c(animFrameIdx, :, :));

    % strain array length = strainLeadInFrames + strainFrames; convolving
    % the full array 'valid' with staFilt yields exactly strainFrames output
    % samples, aligned 1:1 with the displayed wingbeat.
    strain_c = raw.(cond).strain;   % nSensorLocs x nTime
    payload.conditions.(cond).strain = single(strain_c(:, strainStart:iEnd));
end

payload.optimalSensors = struct( ...
    'top1',  sensorsSort(1), ...
    'top5',  sensorsSort(1:5), ...
    'top10', sensors10);

% NOTE (open question for Phase 3 / histogram.js): the Requirements.pdf
% sketch shows the spanwise histogram as two bar groups, "flapping only"
% vs "flapping + rotation". SSPOC as implemented here solves for ONE
% shared sensor set that discriminates between those two conditions --
% there is no natural second sensor set to plot as a separate group. This
% exports a single spanwise histogram of sensors10 for now; the exact
% intended two-group comparison should be revisited against the paper's
% Fig 3C (spanwise location vs. threshold/stiffness) before building
% histogram.js. Also note: the paper aggregates over 20 repeated draws for
% this figure (Fig 3B/3C); this export has only one draw per set.
payload.spanHistogram = spanwiseHistogram({sensors10}, Pars);

payload.accuracyBySensorCount = accBySensorCount;

result = struct();
result.payload = payload;
result.accuracy = struct('top1', accBySensorCount(1), 'top10', accBySensorCount(10), 'all', accAll);

end


function [strain, deform] = simulateConditionWithDeform(rollRot, pitchRot, yawRot, ph, th, ps, Pars)
% Wraps eulerLagrange the same way eulerLagrangeSimWrapper.m does --
% simulate at <=1kHz internally for speed, then interpolate up to the
% desired sampFreq -- but additionally captures & interpolates `deform`,
% which eulerLagrangeSimWrapper.m discards entirely. This is the piece the
% plan calls out as the riskiest part of Phase 0.

if Pars.sampFreq > 1e3
    desiredSampFreq = Pars.sampFreq;
    simPars = Pars;
    simPars.sampFreq = 1e3;
    desiredSimEnd = Pars.simEnd;
    simPars.simEnd = desiredSimEnd + 1/simPars.sampFreq;

    [strainLow, deformLow] = eulerLagrange(rollRot, pitchRot, yawRot, ph, th, ps, simPars);

    tSim = 0 : 1/simPars.sampFreq : (simPars.simEnd - 1/simPars.sampFreq);
    tDesired = 0 : 1/desiredSampFreq : (desiredSimEnd - 1/desiredSampFreq);

    strain = interp1(tSim, strainLow', tDesired, 'spline')';   % nSensorLocs x nTime

    sz = size(deformLow);   % nTime x chordElements x spanElements
    deformFlat = reshape(deformLow, sz(1), []);
    deformFlat = interp1(tSim, deformFlat, tDesired, 'spline');
    deform = reshape(deformFlat, length(tDesired), sz(2), sz(3));
else
    [strain, deform] = eulerLagrange(rollRot, pitchRot, yawRot, ph, th, ps, Pars);
end

end


function Pars = applyQuickOverride(Pars, opt)
% Single source of truth for the quick-mode time-resolution override, used
% both when building each set's Pars and when building manifest.encoding --
% keeping these in two places invites exactly the kind of filter/data
% sample-rate mismatch this function exists to prevent.
if opt.quick
    % Reduced time resolution for a fast Phase-0 schema check. NOT
    % scientifically valid: too few wingbeats for meaningful SSPOC/accuracy,
    % and spike timing precision needs the full sampFreq (paper Methods
    % specifies 0.1 ms precision, which requires sampFreq >= 1e4).
    Pars.sampFreq = 1000;
    Pars.simEnd   = 1.2;
end
end


function fieldName = rotFieldName(rollRot, pitchRot, yawRot)
% Replicates the exact field-naming convention used by
% eulerLagrangeSimWrapper.m / neuralTransformationOfData.m, so StrainSet
% built here is readable by the unmodified neuralTransformationOfData.m.
signTag = 'NP';
rotSignIdxs = round((sign([rollRot pitchRot yawRot])+3)/2);
rotString = ['roll' signTag(rotSignIdxs(1)) num2str(abs(rollRot)) ...
    '_pitch' signTag(rotSignIdxs(2)) num2str(abs(pitchRot)) ...
    '_yaw' signTag(rotSignIdxs(3)) num2str(abs(yawRot))];
fieldName = ['strain_' rotString];
end


function hist = spanwiseHistogram(sensorSets, Pars)
% sensorSets: cell array of sensor-index vectors (one per repeated draw).
% Bins linear sensor indices into spanwise (base-to-tip) counts.
counts = zeros(1, Pars.spanElements);
for i = 1:numel(sensorSets)
    idx = sensorSets{i};
    [~, spanIdx] = ind2sub([Pars.chordElements, Pars.spanElements], idx);
    for j = 1:numel(spanIdx)
        counts(spanIdx(j)) = counts(spanIdx(j)) + 1;
    end
end
hist = counts;
end


function enc = encodingConstants(Pars)
% Replicates the filter-construction logic from
% neuralTransformationOfData.m (lines ~29-40) so the JS port (encoding.js,
% Phase 2) can reproduce P(fire) exactly. Ships both the precomputed filter
% taps (safest -- avoids floating-point drift from re-deriving the cos/exp
% math in JS) and the raw parameters (for reference / sanity-checking).
staT = -19:1000/Pars.sampFreq:0;
staFunc = @(t) cos(Pars.staFreq*(t+Pars.staDelay)) .* exp(-(t+Pars.staDelay).^2 / Pars.staWidth.^2);
f = staFunc(staT);
f = f - mean(f);
if Pars.staFreq < .1
    f = ones(size(f));
end
k = sqrt(1/sum(f.^2));
staFilt = fliplr(k*f/0.2003*1000/Pars.sampFreq);

enc = struct( ...
    'sampFreq', Pars.sampFreq, ...
    'flapFrequency', Pars.flapFrequency, ...
    'refPer', Pars.refPer, ...
    'nldGrad', Pars.nldGrad, ...
    'nldShift', Pars.nldShift, ...
    'staFreq', Pars.staFreq, ...
    'staWidth', Pars.staWidth, ...
    'staDelay', Pars.staDelay, ...
    'normalizeVal', Pars.normalizeVal, ...
    'subSamp', Pars.subSamp, ...
    'staFilt', staFilt);
end


function writeJSON(path, s)
txt = jsonencode(s);
fid = fopen(path, 'w');
if fid == -1
    error('exportForViz:cannotWrite', 'Could not open %s for writing', path);
end
fwrite(fid, txt, 'char');
fclose(fid);
end
